-- ONE-TIME: switch every show to the new 250-seat plan.
-- WARNING: this deletes ALL existing bookings, holds and seats (fine while you
-- only have test bookings). Run it once in Neon's SQL editor.
BEGIN;
DELETE FROM holds;
DELETE FROM bookings;   -- also removes their tickets
DELETE FROM seats;
INSERT INTO seats (show_id, label, row_name, side, seat_number, price_cents)
SELECT sh.id, r.row_name || n.num, r.row_name,
       CASE WHEN n.num <= 10 THEN 'L' ELSE 'R' END, n.num, 1000
FROM shows sh
CROSS JOIN (SELECT unnest(ARRAY['A','B','C','D','E','F','G','H','I','J','K','L','M','N']) AS row_name) r
CROSS JOIN generate_series(1, 20) AS n(num)
WHERE (r.row_name IN ('A','B') AND n.num BETWEEN 6 AND 15)
   OR (r.row_name BETWEEN 'C' AND 'M')
   OR (r.row_name = 'N' AND n.num BETWEEN 11 AND 20);
COMMIT;

-- check: should show 250 for every show
SELECT sh.name, count(*) AS seats FROM seats s JOIN shows sh ON sh.id = s.show_id GROUP BY sh.name ORDER BY sh.name;
