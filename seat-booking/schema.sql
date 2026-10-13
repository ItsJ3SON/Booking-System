-- Seat booking system schema (PostgreSQL)

CREATE TABLE IF NOT EXISTS shows (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  time_tbc BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS seats (
  id SERIAL PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  label TEXT NOT NULL,              -- e.g. "AL3" (row A, left side, 3rd from the aisle)
  row_name TEXT NOT NULL,
  side CHAR(1) NOT NULL,            -- 'L' or 'R' of the center aisle
  seat_number INTEGER NOT NULL,     -- 1 = nearest the aisle, increasing outward
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available', -- available | held | booked
  UNIQUE(show_id, label)
);

CREATE TABLE IF NOT EXISTS holds (
  id SERIAL PRIMARY KEY,
  hold_token TEXT NOT NULL,
  seat_id INTEGER NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  attendee_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_holds_token ON holds(hold_token);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES shows(id),
  customer_email TEXT,              -- empty for cash bookings taken at the door
  payment_method TEXT NOT NULL DEFAULT 'online', -- online | cash
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
  amount_cents INTEGER NOT NULL,
  ticket_code TEXT UNIQUE,
  checked_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_seats (
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  seat_id INTEGER NOT NULL REFERENCES seats(id),
  ticket_code TEXT UNIQUE,          -- each seat = its own ticket with its own QR code
  attendee_name TEXT,
  checked_in_at TIMESTAMPTZ,
  PRIMARY KEY (booking_id, seat_id)
);

-- Admin login sessions, kept in the database (not just in memory) so a
-- logged-in admin stays logged in across Render free-tier spin-downs/restarts,
-- which otherwise silently wipe an in-memory session store and turn every
-- admin API call into an "unauthorized" error that looked like "not found".
CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_holds_expires ON holds(expires_at);
CREATE INDEX IF NOT EXISTS idx_seats_show ON seats(show_id);

-- Two real shows, times to be confirmed later
INSERT INTO shows (name, venue, starts_at, time_tbc)
VALUES
  ('Is-Sibt 26 ta’ Diċembru', 'L-Iskola Primarja ta’ Marsaxlokk', '2026-12-26 19:30:00+00', true),
  ('Il-Ħadd 27 ta’ Diċembru', 'L-Iskola Primarja ta’ Marsaxlokk', '2026-12-27 15:00:00+00', true)
  ('Il-Ħadd 27 ta’ Diċembru', 'L-Iskola Primarja ta’ Marsaxlokk', '2026-12-27 19:30:00+00', true)
ON CONFLICT DO NOTHING;

-- 200 seats per show: 10 rows (A-J), 10 seats on each side of the aisle.
-- Seat 1 on each side sits next to the aisle; numbers increase moving outward.
-- Flat price: €10.00 per seat.
INSERT INTO seats (show_id, label, row_name, side, seat_number, price_cents)
SELECT
  sh.id,
  row_letter || side_letter || seat_num,
  row_letter,
  side_letter,
  seat_num,
  1000
FROM shows sh
CROSS JOIN (SELECT unnest(ARRAY['A','B','C','D','E','F','G','H','I','J']) AS row_letter) rows
CROSS JOIN (SELECT unnest(ARRAY['L','R']) AS side_letter) sides
CROSS JOIN (SELECT generate_series(1,10) AS seat_num) seats
ON CONFLICT (show_id, label) DO NOTHING;
