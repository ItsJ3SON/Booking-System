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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_holds_token ON holds(hold_token);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES shows(id),
  customer_email TEXT NOT NULL,
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
  PRIMARY KEY (booking_id, seat_id)
);

CREATE INDEX IF NOT EXISTS idx_holds_expires ON holds(expires_at);
CREATE INDEX IF NOT EXISTS idx_seats_show ON seats(show_id);

-- Two real shows, times to be confirmed later
INSERT INTO shows (name, venue, starts_at, time_tbc)
VALUES
  ('Show — December 26th', 'Main Theater', '2026-12-26 00:00:00+00', true),
  ('Show — December 27th', 'Main Theater', '2026-12-27 00:00:00+00', true)
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
