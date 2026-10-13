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
// Sessions are stored in the database, not just in memory. Render's free
// tier spins the server down after idle periods and restarts it on the next
// request — that wipes an in-memory session store instantly, which silently
// logged admins out mid-shift and made every /api/admin call come back as
// "unauthorized" (the ticket scanner showed that as a misleading "ticket not
// found" for every single scan). A DB-backed session survives restarts.
async function createAdminSession(res) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await pool.query(`INSERT INTO admin_sessions (token, expires_at) VALUES ($1, $2)`, [token, expiresAt]);
  res.cookie('admin_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: BASE_URL.startsWith('https'),
    maxAge: SESSION_MAX_AGE_MS,
  });
}

async function isValidSession(token) {
  if (!token) return false;
  const { rows } = await pool.query(`SELECT 1 FROM admin_sessions WHERE token=$1 AND expires_at > now()`, [token]);
  return rows.length > 0;
}

// Occasionally sweep out old expired sessions so the table doesn't grow forever.
setInterval(() => {
  pool.query(`DELETE FROM admin_sessions WHERE expires_at <= now()`).catch((err) =>
    console.error('Session cleanup error:', err)
  );
}, 60 * 60 * 1000);

async function requireAdmin(req, res, next) {
  // Allow the login page and login/logout API through without a session.
  if (req.path === '/login.html' || req.path === '/login' || req.path === '/logout') return next();

  try {
    if (await isValidSession(req.cookies.admin_session)) return next();
  } catch (err) {
    console.error('Session check error:', err);
  }

  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.redirect('/admin/login.html?redirect=' + encodeURIComponent(req.originalUrl));
}
app.use('/admin', requireAdmin);
app.use('/api/admin', requireAdmin);

app.post('/api/admin/login', async (req, res) => {
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedPass) {
    return res.status(500).json({ error: 'Admin area is not configured. Set ADMIN_PASSWORD in your environment.' });
  }
  const { username, password } = req.body || {};
  if (username === expectedUser && password === expectedPass) {
    try {
      await createAdminSession(res);
      return res.json({ ok: true });
    } catch (err) {
      console.error('Login session create error:', err);
      return res.status(500).json({ error: 'Could not log in — please try again.' });
    }
  }
  res.status(401).json({ error: 'Incorrect username or password' });
});

app.post('/api/admin/logout', async (req, res) => {
  try {
    if (req.cookies.admin_session) {
      await pool.query(`DELETE FROM admin_sessions WHERE token=$1`, [req.cookies.admin_session]);
    }
  } catch (err) {
    console.error('Logout session delete error:', err);
  }
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

// Sends the confirmation email (one QR code per ticket) once a booking is paid.
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendConfirmationEmail(bookingId) {
  const { rows } = await pool.query(
    `SELECT b.customer_email, b.amount_cents, sh.name AS show_name, sh.venue, sh.starts_at
     FROM bookings b JOIN shows sh ON sh.id = b.show_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (!rows.length) return;
  const booking = rows[0];

  const { rows: tickets } = await pool.query(
    `SELECT bs.ticket_code, bs.attendee_name, s.label
     FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id
     WHERE bs.booking_id = $1 AND bs.ticket_code IS NOT NULL
     ORDER BY s.label`,
    [bookingId]
  );

  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    console.warn('BREVO_API_KEY/BREVO_SENDER_EMAIL not set — skipping email send. Would have emailed:', booking.customer_email);
    return;
  }

  // Hosted image links rather than inline attachments: works with any email
  // provider (Brevo's API can't do inline CID attachments at all) and any
  // email client. The route below generates each PNG on the fly.
  const ticketBlocks = tickets.map((t) => `
          <div style="text-align: center; padding: 24px 0; border-top: 1px solid #e3d8c6;">
            <p style="margin: 0 0 2px; font-size: 17px;">${escapeHtml(t.attendee_name || 'Guest')}</p>
            <p style="margin: 0 0 14px; font-size: 13px; color: #867a6e;">Seat ${escapeHtml(t.label)}</p>
            <img src="${BASE_URL}/api/tickets/${t.ticket_code}/qr.png" alt="QR code for ${escapeHtml(t.attendee_name || t.label)}" width="200" height="200" style="display: block; margin: 0 auto 10px;" />
            <p style="margin: 0; font-size: 12px; color: #a8a090;">Ticket code: ${t.ticket_code}</p>
          </div>`).join('');

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
      subject: `Your tickets — ${booking.show_name}`,
      htmlContent: `
        <div style="font-family: Georgia, 'Times New Roman', serif; max-width: 420px; margin: 0 auto; color: #2b2320; background: #fbf6ee; padding: 32px 28px;">
          <p style="margin: 0 0 4px; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #a8763e;">Booking confirmed</p>
          <h1 style="margin: 0 0 20px; font-size: 22px; font-weight: normal;">${escapeHtml(booking.show_name)}</h1>

          <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6;">
            ${escapeHtml(booking.venue)}<br>
            ${new Date(booking.starts_at).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Malta' })}
          </p>

          <p style="margin: 0 0 8px; font-size: 15px; color: #867a6e;">${tickets.length} ticket${tickets.length === 1 ? '' : 's'} &middot; Total paid €${(booking.amount_cents / 100).toFixed(2)}</p>
          <p style="margin: 0 0 8px; font-size: 14px; color: #867a6e;">Each person shows their own QR code at the door.</p>
          ${ticketBlocks}
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

    // The browser creates the token up front so rapid clicks all share one
    // reservation; fall back to a server-made one if it's missing/malformed.
    const holdToken = (typeof existingToken === 'string' && /^[a-f0-9]{16,64}$/.test(existingToken))
      ? existingToken
      : crypto.randomBytes(16).toString('hex');
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
  const { holdToken, email, showId, attendees } = req.body;
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

    // Safety net: never charge for fewer seats than the customer picked.
    if (Array.isArray(attendees) && attendees.length !== holds.length) {
      return res.status(409).json({ error: 'Your seat reservation changed (a seat may have expired). Please check your seats and try again.' });
    }

    // Every seat needs the name of the person who will sit in it.
    const nameBySeat = {};
    (Array.isArray(attendees) ? attendees : []).forEach((a) => {
      if (a && a.seatId != null) nameBySeat[String(a.seatId)] = String(a.name || '').trim().slice(0, 80);
    });
    const missing = holds.filter((h) => !nameBySeat[String(h.seat_id)]);
    if (missing.length) {
      return res.status(400).json({ error: `Please enter a name for every ticket (missing: ${missing.map((h) => h.label).join(', ')}).` });
    }
    for (const h of holds) {
      await pool.query(`UPDATE holds SET attendee_name=$1 WHERE hold_token=$2 AND seat_id=$3`, [nameBySeat[String(h.seat_id)], holdToken, h.seat_id]);
    }

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
      const { rows: holds } = await client.query('SELECT seat_id, attendee_name FROM holds WHERE hold_token=$1', [holdToken]);

      if (holds.length) {
        const seatIds = holds.map((h) => h.seat_id);
        await client.query(`UPDATE seats SET status='booked' WHERE id = ANY($1::int[])`, [seatIds]);
        // One ticket (own QR code, own name, own check-in) per seat.
        for (const h of holds) {
          await client.query(
            `INSERT INTO booking_seats (booking_id, seat_id, ticket_code, attendee_name) VALUES ($1,$2,$3,$4)`,
            [bookingId, h.seat_id, crypto.randomBytes(8).toString('hex'), h.attendee_name]
          );
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

// Cash booking at the door: marks seats as booked + paid, with NO email and NO QR code.
app.post('/api/admin/cash-booking', async (req, res) => {
  const { showId, seatIds, name } = req.body || {};
  if (!/^\d+$/.test(String(showId)) || !Array.isArray(seatIds) || !seatIds.length || seatIds.length > 50
      || !seatIds.every((i) => Number.isInteger(i))) {
    return res.status(400).json({ error: 'Pick a show and at least one seat.' });
  }
  const attendee = String(name || '').trim().slice(0, 80) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await releaseExpiredHolds(client);
    const { rows: seats } = await client.query(
      `SELECT id, status, price_cents FROM seats WHERE id = ANY($1::int[]) AND show_id = $2 FOR UPDATE`,
      [seatIds, showId]
    );
    if (seats.length !== seatIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'One of those seats does not exist for this show.' });
    }
    if (seats.some((s) => s.status !== 'available')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'One of those seats was just taken. Seat map refreshed — please pick again.' });
    }
    const amount = seats.reduce((n, s) => n + s.price_cents, 0);
    const { rows: b } = await client.query(
      `INSERT INTO bookings (show_id, customer_email, status, amount_cents, payment_method)
       VALUES ($1, NULL, 'paid', $2, 'cash') RETURNING id`,
      [showId, amount]
    );
    await client.query(`UPDATE seats SET status='booked' WHERE id = ANY($1::int[])`, [seatIds]);
    for (const id of seatIds) {
      await client.query(`INSERT INTO booking_seats (booking_id, seat_id, attendee_name) VALUES ($1,$2,$3)`, [b[0].id, id, attendee]);
    }
    await client.query('COMMIT');
    res.json({ bookingId: b[0].id, amount_cents: amount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Cash booking error:', err);
    res.status(500).json({ error: 'Could not save the cash booking.' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/bookings', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.id, b.show_id, b.customer_email, b.payment_method, b.status, b.amount_cents, b.created_at, sh.name AS show_name,
             COALESCE((
               SELECT json_agg(json_build_object(
                        'code', bs.ticket_code, 'name', bs.attendee_name,
                        'label', s.label, 'checked_in_at', bs.checked_in_at
                      ) ORDER BY s.label)
               FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id
               WHERE bs.booking_id = b.id
             ), '[]'::json) AS tickets
      FROM bookings b
      JOIN shows sh ON sh.id = b.show_id
      ORDER BY b.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Admin bookings error:', err);
    res.status(500).json({ error: 'Could not load bookings' });
  }
});

// Looks up ONE ticket (one seat, one person) by its own code.
app.get('/api/admin/tickets/:code', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.customer_email, b.show_id, sh.name AS show_name, bs.attendee_name, bs.checked_in_at,
             ARRAY[s.label] AS seat_labels
      FROM booking_seats bs
      JOIN bookings b ON b.id = bs.booking_id
      JOIN shows sh ON sh.id = b.show_id
      JOIN seats s ON s.id = bs.seat_id
      WHERE bs.ticket_code = $1 AND b.status = 'paid'
    `, [req.params.code]);
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Ticket lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
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
    const { rows } = await pool.query('SELECT status, payment_method FROM bookings WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    if (rows[0].status !== 'paid' || rows[0].payment_method === 'cash') {
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
  try {
    // If the scanner says which show it is scanning for, only check the ticket
    // in when it really belongs to that show (so a wrong-day ticket can never
    // be checked in, even if the page is bypassed).
    const showId = req.body && /^\d+$/.test(String(req.body.showId)) ? Number(req.body.showId) : null;
    const { rows } = await pool.query(
      `UPDATE booking_seats bs SET checked_in_at = now()
       FROM bookings b
       WHERE b.id = bs.booking_id AND b.status = 'paid'
         AND bs.ticket_code = $1 AND bs.checked_in_at IS NULL
         AND ($2::int IS NULL OR b.show_id = $2::int)
       RETURNING bs.booking_id, bs.checked_in_at`,
      [req.params.code, showId]
    );
    if (!rows.length) return res.status(409).json({ error: 'Ticket not found, wrong show, or already checked in' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ error: 'Check-in failed' });
  }
});

// Safety net: any error that reaches here (instead of being caught in a route)
// still gets a proper JSON response instead of an empty/broken one.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => console.log(`Seat booking server running on ${BASE_URL}`));
