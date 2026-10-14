-- ONE-TIME: set the real show times (Malta time, UTC+1 in December) and remove "Time TBC".
UPDATE shows SET starts_at = '2026-12-26 19:30:00+01', time_tbc = false WHERE starts_at = '2026-12-26 19:30:00+00';
UPDATE shows SET starts_at = '2026-12-27 15:00:00+01', time_tbc = false WHERE starts_at = '2026-12-27 15:00:00+00';
UPDATE shows SET starts_at = '2026-12-27 19:30:00+01', time_tbc = false WHERE starts_at = '2026-12-27 19:30:00+00';

-- check
SELECT name, starts_at AT TIME ZONE 'Europe/Malta' AS malta_time, time_tbc FROM shows ORDER BY starts_at;
