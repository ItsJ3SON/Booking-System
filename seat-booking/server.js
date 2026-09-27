require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
const Stripe = require('stripe');
const QRCode = require('qrcode');
const { pool } = require('./db');

// Safety net: on modern Node, an unhandled promise rejection anywhere crashes
// the whole process by default. Log it instead so one bad request can't take
// the entire server down.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
// Email via Brevo's HTTP API (not SMTP) — Render's free tier blocks outbound
// SMTP ports entirely, so a regular SMTP service (Gmail included) can't work
// here at all. Brevo's free plan sends over plain HTTPS instead, which isn't
// blocked, sends 300/day free, and — unlike Resend's testing sandbox — can
// send to any recipient once your one sender address is verified (a single
// click on a confirmation email Brevo sends you, no domain purchase needed).
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Seat Booking';
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES || 10);
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Stripe webhook needs the raw body, so it must be registered BEFORE express.json()
app.post('/api/webhook', express.raw({ type: 'application/json' }), handleWebhook);

app.use(express.json());
app.use(cookieParser());

// ---- admin auth: real login page + session cookie (no browser popup) ----
// In-memory session store. Simple and fine for a single-admin small project;
// note sessions are lost if the server restarts (e.g. Render free tier spin-down),
// which just means logging in again — no data is lost.
const adminSessions = new Map(); // token -> expiresAt

function createAdminSession(res) {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, Date.now() + SESSION_MAX_AGE_MS);
  res.cookie('admin_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: BASE_URL.startsWith('https'),
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function isValidSession(token) {
  if (!token || !adminSessions.has(token)) return false;
  const expiresAt = adminSessions.get(token);
  if (Date.now() > expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  // Allow the login page and login/logout API through without a session.
  if (req.path === '/login.html' || req.path === '/login' || req.path === '/logout') return next();

  if (isValidSession(req.cookies.admin_session)) return next();

  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.redirect('/admin/login.html?redirect=' + encodeURIComponent(req.originalUrl));
}
app.use('/admin', requireAdmin);
app.use('/api/admin', requireAdmin);

app.post('/api/admin/login', (req, res) => {
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedPass) {
    return res.status(500).json({ error: 'Admin area is not configured. Set ADMIN_PASSWORD in your environment.' });
  }
  const { username, password } = req.body || {};
  if (username === expectedUser && password === expectedPass) {
    createAdminSession(res);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Incorrect username or password' });
});

app.post('/api/admin/logout', (req, res) => {
  if (req.cookies.admin_session) adminSessions.delete(req.cookies.admin_session);
  res.clearCookie('admin_session');
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- helpers ----

async function releaseExpiredHolds(client = pool) {
  // Any hold past its expiry: seat goes back to available, hold row removed.
  await client.query(`
    UPDATE seats SET status = 'available'
    WHERE id IN (SELECT seat_id FROM holds WHERE expires_at < now())
      AND status = 'held'
  `);
  await client.query(`DELETE FROM holds WHERE expires_at < now()`);
}

// Background sweep every 30s, belt-and-suspenders in addition to on-demand cleanup.
setInterval(() => releaseExpiredHolds().catch(console.error), 30 * 1000);

// Backstop: a booking normally flips from 'pending' to 'paid'/'failed' via the
// Stripe webhook. If that webhook is ever missed (or the session never got
// created at all), this catches it so nothing sits as "pending" forever.
async function failStalePendingBookings() {
  await pool.query(`
    UPDATE bookings SET status = 'failed'
    WHERE status = 'pending' AND created_at < now() - interval '40 minutes'
  `);
}
setInterval(() => failStalePendingBookings().catch(console.error), 5 * 60 * 1000);

// Sends the confirmation email with an inline QR code, once a booking is paid.
async function sendConfirmationEmail(bookingId) {
  const { rows } = await pool.query(
    `SELECT b.customer_email, b.ticket_code, b.amount_cents, sh.name AS show_name, sh.venue, sh.starts_at,
            array_agg(s.label ORDER BY s.label) AS seat_labels
     FROM bookings b
     JOIN shows sh ON sh.id = b.show_id
     LEFT JOIN booking_seats bs ON bs.booking_id = b.id
     LEFT JOIN seats s ON s.id = bs.seat_id
     WHERE b.id = $1
     GROUP BY b.id, sh.id`,
    [bookingId]
  );
  if (!rows.length) return;
  const booking = rows[0];

  const verifyUrl = `${BASE_URL}/admin/ticket.html?code=${booking.ticket_code}`;
  // Hosted image link rather than an inline attachment: works with any email
  // provider (Brevo's API can't do inline CID attachments at all) and any
  // email client. The route below generates this PNG on the fly.
  const qrImageUrl = `${BASE_URL}/api/tickets/${booking.ticket_code}/qr.png`;

  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    console.warn('BREVO_API_KEY/BREVO_SENDER_EMAIL not set — skipping email send. Would have emailed:', booking.customer_email);
    return;
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
      to: [{ email: booking.customer_email }],
      subject: `Your tickets for ${booking.show_name}`,
      htmlContent: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h1 style="font-size: 20px;">🎉 Booking confirmed</h1>
          <p><strong>${booking.show_name}</strong><br>
          ${booking.venue}<br>
          ${new Date(booking.starts_at).toLocaleString()}</p>
          <p><strong>Seats:</strong> ${booking.seat_labels.join(', ')}<br>
          <strong>Total paid:</strong> €${(booking.amount_cents / 100).toFixed(2)}</p>
          <p>Show this QR code at the door:</p>
          <img src="${qrImageUrl}" alt="Ticket QR code" width="240" height="240" />
          <p style="color:#888; font-size: 12px;">Ticket code: ${booking.ticket_code}</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Brevo send failed (${res.status}): ${errText}`);
  }
}

// ---- routes ----

app.get('/api/shows', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM shows ORDER BY starts_at');
    res.json(rows);
  } catch (err) {
    console.error('List shows error:', err);
    res.status(500).json({ error: 'Could not load shows' });
  }
});

app.get('/api/shows/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid show id' });
  try {
    const { rows } = await pool.query('SELECT * FROM shows WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Show not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Get show error:', err);
    res.status(500).json({ error: 'Could not load show' });
  }
});

app.get('/api/shows/:id/seats', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid show id' });
  try {
    await releaseExpiredHolds();
    const { rows } = await pool.query(
      `SELECT id, label, row_name, side, seat_number, price_cents, status
       FROM seats WHERE show_id=$1 ORDER BY row_name, side, seat_number`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('List seats error:', err);
    res.status(500).json({ error: 'Could not load seats' });
  }
});

// Create a time-limited hold on one or more seats.
// Instantly holds ONE seat the moment it's clicked (no separate "Reserve" step).
// If holdToken is provided and already has seats under it, this adds to that
// same group and refreshes the whole group's expiry back to a fresh HOLD_MINUTES —
// so actively picking seats keeps extending your time, and the countdown always
// reflects "time left since your last click," not a fixed window from your first click.
app.post('/api/holds/add', async (req, res) => {
  const { showId, seatId, holdToken: existingToken } = req.body;
  if (!showId || !seatId) {
    return res.status(400).json({ error: 'showId and seatId are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await releaseExpiredHolds(client);

    const { rows: seatRows } = await client.query(
      `SELECT id, status FROM seats WHERE id=$1 AND show_id=$2 FOR UPDATE`,
      [seatId, showId]
    );
    if (!seatRows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Seat does not exist for this show' });
    }
    if (seatRows[0].status !== 'available') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That seat is no longer available' });
    }

    const holdToken = existingToken || crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);

    await client.query(`UPDATE seats SET status='held' WHERE id=$1`, [seatId]);
    await client.query(
      `INSERT INTO holds (hold_token, seat_id, expires_at) VALUES ($1, $2, $3)`,
      [holdToken, seatId, expiresAt]
    );
    // Refresh every seat already under this token to the same fresh expiry.
    await client.query(`UPDATE holds SET expires_at=$1 WHERE hold_token=$2`, [expiresAt, holdToken]);

    await client.query('COMMIT');
    res.json({ holdToken, expiresAt });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Add hold error:', err);
    res.status(500).json({ error: 'Could not reserve seat' });
  } finally {
    client.release();
  }
});

// Releases a single seat a customer had held (e.g. they clicked it again to deselect).
app.post('/api/holds/release', async (req, res) => {
  const { holdToken, seatId } = req.body;
  if (!holdToken || !seatId) {
    return res.status(400).json({ error: 'holdToken and seatId are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM holds WHERE hold_token=$1 AND seat_id=$2 RETURNING seat_id`,
      [holdToken, seatId]
    );
    if (rows.length) {
      await client.query(`UPDATE seats SET status='available' WHERE id=$1`, [seatId]);
    }
    await client.query('COMMIT');
    res.json({ released: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Release hold error:', err);
    res.status(500).json({ error: 'Could not release seat' });
  } finally {
    client.release();
  }
});

// Start Stripe Checkout for a held set of seats.
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

    // Stripe requires a Checkout Session to stay valid at least 30 minutes,
    // so we can't tie it exactly to a short seat hold. Our own hold-expiry
    // logic (checked on every request + the 30s background sweep) is what
    // actually releases seats in time; this Stripe-side expiry is just a backstop.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: holds.map((h) => ({
        price_data: {
          currency: 'eur',
          product_data: { name: `Seat ${h.label}` },
          unit_amount: h.price_cents,
        },
        quantity: 1,
      })),
      metadata: { holdToken, bookingId: String(bookingId) },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/index.html`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 min, Stripe's minimum
    });

    await pool.query(`UPDATE bookings SET stripe_session_id=$1 WHERE id=$2`, [session.id, bookingId]);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// Stripe calls this. Confirms payment -> converts hold into a real booking.
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
      const ticketCode = crypto.randomBytes(8).toString('hex');
      await client.query(
        `UPDATE bookings SET status='paid', stripe_payment_intent_id=$1, ticket_code=$2 WHERE id=$3`,
        [session.payment_intent, ticketCode, bookingId]
      );
      await client.query('COMMIT');

      sendConfirmationEmail(bookingId).catch((err) => console.error('Email send failed:', err));
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

// Publicly generates the QR image itself, so the email can reference it as a
// normal hosted <img src>. The ticket_code is an unguessable random token, so
// this doesn't leak anything sensitive beyond what the QR already points to.
app.get('/api/tickets/:code/qr.png', async (req, res) => {
  try {
    const verifyUrl = `${BASE_URL}/admin/ticket.html?code=${req.params.code}`;
    const buffer = await QRCode.toBuffer(verifyUrl, { width: 240 });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error('QR image error:', err);
    res.status(500).send('Could not generate QR code');
  }
});

app.get('/api/bookings/by-session/:sessionId', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE stripe_session_id=$1', [req.params.sessionId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// ---- admin routes (behind requireAdmin above) ----

// Lets an admin manually take a seat out of sale (e.g. reserved for a VIP) or
// release it back to sale, without going through a real booking/payment.
app.post('/api/admin/seats/:id/block', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE seats SET status='blocked' WHERE id=$1 AND status='available' RETURNING id`,
    [req.params.id]
  );
  if (!rows.length) return res.status(409).json({ error: 'Seat is not available to block (already held, booked, or blocked)' });
  res.json({ blocked: true });
});

app.post('/api/admin/seats/:id/unblock', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE seats SET status='available' WHERE id=$1 AND status='blocked' RETURNING id`,
    [req.params.id]
  );
  if (!rows.length) return res.status(409).json({ error: 'Seat is not currently blocked' });
  res.json({ unblocked: true });
});

app.get('/api/admin/bookings', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT b.id, b.customer_email, b.status, b.amount_cents, b.ticket_code, b.checked_in_at, b.created_at,
           sh.name AS show_name,
           COALESCE(array_agg(s.label ORDER BY s.label) FILTER (WHERE s.label IS NOT NULL), '{}') AS seat_labels
    FROM bookings b
    JOIN shows sh ON sh.id = b.show_id
    LEFT JOIN booking_seats bs ON bs.booking_id = b.id
    LEFT JOIN seats s ON s.id = bs.seat_id
    GROUP BY b.id, sh.id
    ORDER BY b.created_at DESC
  `);
  res.json(rows);
});

app.get('/api/admin/tickets/:code', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT b.id, b.customer_email, b.status, b.checked_in_at, sh.name AS show_name,
           COALESCE(array_agg(s.label ORDER BY s.label) FILTER (WHERE s.label IS NOT NULL), '{}') AS seat_labels
    FROM bookings b
    JOIN shows sh ON sh.id = b.show_id
    LEFT JOIN booking_seats bs ON bs.booking_id = b.id
    LEFT JOIN seats s ON s.id = bs.seat_id
    WHERE b.ticket_code = $1
    GROUP BY b.id, sh.id
  `, [req.params.code]);
  if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
  res.json(rows[0]);
});

app.delete('/api/admin/bookings/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: seatRows } = await client.query('SELECT seat_id FROM booking_seats WHERE booking_id=$1', [req.params.id]);
    if (seatRows.length) {
      const seatIds = seatRows.map((r) => r.seat_id);
      await client.query(`UPDATE seats SET status='available' WHERE id = ANY($1::int[])`, [seatIds]);
    }
    const { rowCount } = await client.query('DELETE FROM bookings WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    if (!rowCount) return res.status(404).json({ error: 'Booking not found' });
    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete booking error:', err);
    res.status(500).json({ error: 'Could not delete booking' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/bookings/:id/resend-email', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT status, ticket_code FROM bookings WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    if (rows[0].status !== 'paid' || !rows[0].ticket_code) {
      return res.status(400).json({ error: 'Only paid bookings can have their confirmation email resent' });
    }
    await sendConfirmationEmail(req.params.id);
    res.json({ sent: true });
  } catch (err) {
    console.error('Resend email error:', err);
    res.status(500).json({ error: 'Could not resend email' });
  }
});

app.post('/api/admin/tickets/:code/checkin', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE bookings SET checked_in_at = now() WHERE ticket_code = $1 AND checked_in_at IS NULL RETURNING id, checked_in_at`,
    [req.params.code]
  );
  if (!rows.length) return res.status(409).json({ error: 'Ticket not found or already checked in' });
  res.json(rows[0]);
});

// Safety net: any error that reaches here (instead of being caught in a route)
// still gets a proper JSON response instead of an empty/broken one.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => console.log(`Seat booking server running on ${BASE_URL}`));
