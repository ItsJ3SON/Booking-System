require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Stripe = require('stripe');
const { pool } = require('./db');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES || 10);
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Stripe webhook needs the raw body, so it must be registered BEFORE express.json()
app.post('/api/webhook', express.raw({ type: 'application/json' }), handleWebhook);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- helpers ----

async function releaseExpiredHolds(client = pool) {
  await client.query(`
    UPDATE seats SET status = 'available'
    WHERE id IN (SELECT seat_id FROM holds WHERE expires_at < now())
      AND status = 'held'
  `);
  await client.query(`DELETE FROM holds WHERE expires_at < now()`);
}

setInterval(() => releaseExpiredHolds().catch(console.error), 30 * 1000);

// ---- routes ----

app.get('/api/shows/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shows WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Show not found' });
  res.json(rows[0]);
});

app.get('/api/shows/:id/seats', async (req, res) => {
  await releaseExpiredHolds();
  const { rows } = await pool.query(
    `SELECT id, label, row_name, seat_number, price_cents, status
     FROM seats WHERE show_id=$1 ORDER BY row_name, seat_number`,
    [req.params.id]
  );
  res.json(rows);
});

app.post('/api/holds', async (req, res) => {
  const { showId, seatIds } = req.body;
  if (!showId || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'showId and seatIds[] are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await releaseExpiredHolds(client);

    const { rows: seats } = await client.query(
      `SELECT id, status FROM seats WHERE id = ANY($1::int[]) AND show_id=$2 FOR UPDATE`,
      [seatIds, showId]
    );

    if (seats.length !== seatIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'One or more seats do not exist for this show' });
    }
    const unavailable = seats.filter((s) => s.status !== 'available');
    if (unavailable.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Some seats are no longer available', seatIds: unavailable.map((s) => s.id) });
    }

    const holdToken = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);

    await client.query(`UPDATE seats SET status='held' WHERE id = ANY($1::int[])`, [seatIds]);
    for (const seatId of seatIds) {
      await client.query(
        `INSERT INTO holds (hold_token, seat_id, expires_at) VALUES ($1, $2, $3)`,
        [holdToken, seatId, expiresAt]
      );
    }

    await client.query('COMMIT');
    res.json({ holdToken, expiresAt });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not create hold' });
  } finally {
    client.release();
  }
});

app.post('/api/checkout', async (req, res) => {
  const { holdToken, email, showId } = req.body;
  if (!holdToken || !email) return res.status(400).json({ error: 'holdToken and email are required' });

  try {
    await releaseExpiredHolds();

    const { rows: holds } = await pool.query(
      `SELECT h.seat_id, h.expires_at, s.label, s.price_cents
       FROM holds h JOIN seats s ON s.id = h.seat_id
       WHERE h.hold_token=$1`,
      [holdToken]
    );
    if (!holds.length) return res.status(410).json({ error: 'Hold expired or not found. Please reselect your seats.' });

    const amountCents = holds.reduce((sum, h) => sum + h.price_cents, 0);

    const { rows: bookingRows } = await pool.query(
      `INSERT INTO bookings (show_id, customer_email, status, amount_cents) VALUES ($1,$2,'pending',$3) RETURNING id`,
      [showId, email, amountCents]
    );
    const bookingId = bookingRows[0].id;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: holds.map((h) => ({
        price_data: {
          currency: 'usd',
          product_data: { name: `Seat ${h.label}` },
          unit_amount: h.price_cents,
        },
        quantity: 1,
      })),
      metadata: { holdToken, bookingId: String(bookingId) },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/index.html`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    await pool.query(`UPDATE bookings SET stripe_session_id=$1 WHERE id=$2`, [session.id, bookingId]);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

async function handleWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const client = await pool.connect();
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { holdToken, bookingId } = session.metadata;

      await client.query('BEGIN');
      const { rows: holds } = await client.query('SELECT seat_id FROM holds WHERE hold_token=$1', [holdToken]);

      if (holds.length) {
        const seatIds = holds.map((h) => h.seat_id);
        await client.query(`UPDATE seats SET status='booked' WHERE id = ANY($1::int[])`, [seatIds]);
        for (const seatId of seatIds) {
          await client.query(`INSERT INTO booking_seats (booking_id, seat_id) VALUES ($1,$2)`, [bookingId, seatId]);
        }
        await client.query(`DELETE FROM holds WHERE hold_token=$1`, [holdToken]);
      }
      await client.query(
        `UPDATE bookings SET status='paid', stripe_payment_intent_id=$1 WHERE id=$2`,
        [session.payment_intent, bookingId]
      );
      await client.query('COMMIT');
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const { holdToken, bookingId } = session.metadata;
      await client.query('BEGIN');
      await client.query(
        `UPDATE seats SET status='available' WHERE id IN (SELECT seat_id FROM holds WHERE hold_token=$1)`,
        [holdToken]
      );
      await client.query(`DELETE FROM holds WHERE hold_token=$1`, [holdToken]);
      await client.query(`UPDATE bookings SET status='failed' WHERE id=$1`, [bookingId]);
      await client.query('COMMIT');
    }

    res.json({ received: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Webhook handler error');
  } finally {
    client.release();
  }
}

app.get('/api/bookings/by-session/:sessionId', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE stripe_session_id=$1', [req.params.sessionId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => console.log(`Seat booking server running on ${BASE_URL}`));
