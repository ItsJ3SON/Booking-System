// One-off script: creates seats for show_id=1 if none exist.
// Usage: node seed.js
require('dotenv').config();
const { pool } = require('./db');

const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS_PER_ROW = 8;

async function seed() {
  const { rows: shows } = await pool.query('SELECT id FROM shows ORDER BY id LIMIT 1');
  if (!shows.length) {
    console.error('No show found. Run schema.sql first.');
    process.exit(1);
  }
  const showId = shows[0].id;

  const { rows: existing } = await pool.query('SELECT COUNT(*) FROM seats WHERE show_id=$1', [showId]);
  if (Number(existing[0].count) > 0) {
    console.log('Seats already exist for show', showId);
    process.exit(0);
  }

  for (const row of ROWS) {
    // front rows cost more
    const price = row === 'A' || row === 'B' ? 8000 : 5000; // cents
    for (let n = 1; n <= SEATS_PER_ROW; n++) {
      const label = `${row}${n}`;
      await pool.query(
        `INSERT INTO seats (show_id, label, row_name, seat_number, price_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [showId, label, row, n, price]
      );
    }
  }
  console.log(`Seeded ${ROWS.length * SEATS_PER_ROW} seats for show ${showId}`);
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
