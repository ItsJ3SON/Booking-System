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

-- Three real shows. Times are Malta local time (UTC+1 in December).
-- Only inserts a show if one with that start time doesn't exist yet, so it is
-- safe to run this file more than once without creating duplicate shows.
INSERT INTO shows (name, venue, starts_at, time_tbc)
SELECT v.name, v.venue, v.starts_at::timestamptz, v.time_tbc
FROM (VALUES
  ('Is-Sibt 26 ta’ Diċembru',          'L-Iskola Primarja ta’ Marsaxlokk', '2026-12-26 19:30:00+01', false),
  ('Il-Ħadd 27 ta’ Diċembru — 15:00', 'L-Iskola Primarja ta’ Marsaxlokk', '2026-12-27 15:00:00+01', false),
  ('Il-Ħadd 27 ta’ Diċembru — 19:30', 'L-Iskola Primarja ta’ Marsaxlokk', '2026-12-27 19:30:00+01', false)
) AS v(name, venue, starts_at, time_tbc)
WHERE NOT EXISTS (SELECT 1 FROM shows s WHERE s.starts_at = v.starts_at::timestamptz);

-- If your 27th 15:00 show was created earlier with the plain name, give it the
-- time in its name so the two Sunday shows can be told apart:
UPDATE shows SET name = 'Il-Ħadd 27 ta’ Diċembru — 15:00'
WHERE starts_at = '2026-12-27 15:00:00+01' AND name = 'Il-Ħadd 27 ta’ Diċembru';

-- Seating plan (250 seats per show). Seats are numbered 1-20 across each row:
-- 1-10 on the left of the aisle, 11-20 on the right.
--   Rows A, B : seats 6-15 only (10 seats)
--   Rows C-M  : seats 1-20     (20 seats each)
--   Row  N    : seats 11-20 only (10 seats)
-- Flat price: €10.00 per seat. Safe to re-run: only missing seats are added.
INSERT INTO seats (show_id, label, row_name, side, seat_number, price_cents)
SELECT sh.id, r.row_name || n.num, r.row_name,
       CASE WHEN n.num <= 10 THEN 'L' ELSE 'R' END, n.num, 1000
FROM shows sh
CROSS JOIN (SELECT unnest(ARRAY['A','B','C','D','E','F','G','H','I','J','K','L','M','N']) AS row_name) r
CROSS JOIN generate_series(1, 20) AS n(num)
WHERE (r.row_name IN ('A','B') AND n.num BETWEEN 6 AND 15)
   OR (r.row_name BETWEEN 'C' AND 'M')
   OR (r.row_name = 'N' AND n.num BETWEEN 11 AND 20)
ON CONFLICT (show_id, label) DO NOTHING;
