-- Seat booking system schema (PostgreSQL)

CREATE TABLE IF NOT EXISTS shows (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL
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
  hold_token TEXT NOT NULL UNIQUE,
  seat_id INTEGER NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES shows(id),
  customer_email TEXT NOT NULL,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
  amount_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_seats (
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  seat_id INTEGER NOT NULL REFERENCES seats(id),
  PRIMARY KEY (booking_id, seat_id)
);

CREATE INDEX IF NOT EXISTS idx_holds_expires ON holds(expires_at);
CREATE INDEX IF NOT EXISTS idx_seats_show ON seats(show_id);

-- Demo seed data: one show, 40 seats (5 rows x 8 seats)
INSERT INTO shows (name, venue, starts_at)
VALUES ('Opening Night', 'Main Theater', now() + interval '14 days')
ON CONFLICT DO NOTHING;
