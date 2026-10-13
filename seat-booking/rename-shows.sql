-- ONE-TIME: put the time in the Saturday show's name too, like the Sunday shows.
UPDATE shows SET name = 'Is-Sibt 26 ta’ Diċembru — 19:30'
WHERE starts_at = '2026-12-26 19:30:00+01';

SELECT name, starts_at AT TIME ZONE 'Europe/Malta' AS malta_time FROM shows ORDER BY starts_at;
