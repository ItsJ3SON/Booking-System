# Seat Booking System

A deployable seat-booking system: customers pick seats on a map, get a time-limited hold
(default 10 minutes) to complete payment, and pay via Stripe Checkout. Unpaid holds release
automatically so seats don't get stuck.

## How it works

1. **Browse** — `GET /api/shows/:id/seats` returns each seat's status (`available`, `held`, `booked`). Expired holds are swept before every read, plus a background job runs every 30s.
2. **Hold** — `POST /api/holds` locks the chosen seats to one buyer for `HOLD_MINUTES`, using row-level locks (`SELECT ... FOR UPDATE`) so two people can't grab the same seat.
3. **Pay** — `POST /api/checkout` creates a Stripe Checkout Session priced from the held seats. The session itself expires exactly when the hold does.
4. **Confirm** — Stripe calls `POST /api/webhook` on `checkout.session.completed`, which converts the hold into a real booking and marks the seats `booked`. On `checkout.session.expired`, seats are released back to `available`.

This webhook step is why payment confirmation is reliable even if the customer closes their browser after paying — Stripe tells your server directly.

## Local setup

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and Stripe keys
psql "$DATABASE_URL" -f schema.sql
npm run seed                 # creates 40 demo seats for the sample show
npm start
```

For local webhook testing, install the [Stripe CLI](https://stripe.com/docs/stripe-cli) and run:
```bash
stripe listen --forward-to localhost:3000/api/webhook
```
Copy the `whsec_...` it prints into `.env` as `STRIPE_WEBHOOK_SECRET`.

Then open `http://localhost:3000`.

## Deploying for real

1. **Database**: provision managed Postgres (Render, Railway, Supabase, RDS...) and run `schema.sql` against it.
2. **App host**: Render, Railway, Fly.io, or a VPS all work — it's a plain Node/Express app. Set the env vars from `.env.example`.
3. **Stripe**: switch `STRIPE_SECRET_KEY` to your live key, and add a webhook endpoint in the Stripe Dashboard pointing at `https://yourdomain.com/api/webhook` subscribed to `checkout.session.completed` and `checkout.session.expired`. Use the signing secret it gives you.
4. **BASE_URL**: set to your real domain so Stripe redirects work.

## Extending beyond the demo

- Multiple shows: the schema already supports many `shows`; the frontend currently hardcodes `SHOW_ID = 1` in `public/app.js` — read it from the URL (`?show=2`) instead.
- Email confirmations: send one from the webhook handler after marking a booking `paid` (e.g. via Resend, Postmark, or SES).
- Admin view: a simple authenticated page listing `bookings` joined to `booking_seats` gives you a box-office view.
- Refunds/cancellations: use `stripe.refunds.create` and revert the seat's status to `available`.

## Files

- `schema.sql` — database tables
- `seed.js` — creates demo seats for the sample show
- `server.js` — Express API (holds, checkout, webhook)
- `db.js` — Postgres connection pool
- `public/` — seat map UI (`index.html`, `app.js`, `style.css`) and post-payment page (`success.html`)
