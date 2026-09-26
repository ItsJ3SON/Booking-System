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
  label TEXT NOT NULL,              -- e.g. "A1"
  row_name TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
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

-- 200 seats per show: 10 rows (A-J) x 20 seats, seats 1-10 and 11-20 split by
-- an aisle (rendered visually on the frontend, not stored differently here).
-- Front two rows (A, B) are priced higher than the rest.
INSERT INTO seats (show_id, label, row_name, seat_number, price_cents)
SELECT
  sh.id,
  row_letter || seat_num,
  row_letter,
  seat_num,
  CASE WHEN row_letter IN ('A','B') THEN 8000 ELSE 5000 END
FROM shows sh
CROSS JOIN (SELECT unnest(ARRAY['A','B','C','D','E','F','G','H','I','J']) AS row_letter) rows
CROSS JOIN (SELECT generate_series(1,20) AS seat_num) seats
ON CONFLICT (show_id, label) DO NOTHING;
