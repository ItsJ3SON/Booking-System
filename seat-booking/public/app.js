const SHOW_ID = new URLSearchParams(location.search).get('show');
if (!SHOW_ID) {
  location.href = '/shows.html';
  throw new Error('No show selected — redirecting.'); // stop this script from running further
}

let seats = [];
let heldSeatIds = new Set(); // seats *I* am currently holding
let holdToken = null;
let holdExpiresAt = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const summaryEl = document.getElementById('selection-summary');
const timerEl = document.getElementById('timer');
const checkoutForm = document.getElementById('checkout-form');
const payBtn = document.getElementById('pay-btn');
const errorEl = document.getElementById('error-msg');

async function loadShow() {
  const show = await fetch(`/api/shows/${SHOW_ID}`).then((r) => r.json());
  document.getElementById('show-name').textContent = show.name;
  const date = new Date(show.starts_at);
  const dateStr = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const whenStr = show.time_tbc ? `${dateStr} — Time TBC` : `${dateStr}, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  document.getElementById('show-meta').textContent = `${show.venue} — ${whenStr}`;
}

async function loadSeats() {
  seats = await fetch(`/api/shows/${SHOW_ID}/seats`).then((r) => r.json());
  renderSeats();
}

function makeSeatButton(seat) {
  const btn = document.createElement('button');
  btn.className = 'seat';
  btn.textContent = seat.seat_number;
  btn.title = `${seat.label} — €${(seat.price_cents / 100).toFixed(2)}`;
  if (heldSeatIds.has(seat.id)) btn.classList.add('selected');
  else if (seat.status !== 'available') btn.classList.add(seat.status);

  if (seat.status === 'available' || heldSeatIds.has(seat.id)) {
    btn.addEventListener('click', () => toggleSeat(seat.id));
  } else {
    btn.disabled = true;
  }
  return btn;
}

function makeRowLabel(rowName) {
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = rowName;
  return label;
}

function renderSeats() {
  const rows = {};
  seats.forEach((s) => { (rows[s.row_name] ||= []).push(s); });

  seatMapEl.innerHTML = '';
  Object.keys(rows).sort().forEach((rowName) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';

    const left = rows[rowName].filter((s) => s.side === 'L').sort((a, b) => a.seat_number - b.seat_number);
    const right = rows[rowName].filter((s) => s.side === 'R').sort((a, b) => a.seat_number - b.seat_number);

    rowEl.appendChild(makeRowLabel(rowName));
    // Left side is rendered outer-to-inner so seat #1 lands next to the aisle.
    [...left].reverse().forEach((seat) => rowEl.appendChild(makeSeatButton(seat)));

    const gap = document.createElement('div');
    gap.className = 'aisle-gap';
    rowEl.appendChild(gap);

    // Right side is rendered inner-to-outer — seat #1 is also next to the aisle.
    right.forEach((seat) => rowEl.appendChild(makeSeatButton(seat)));

    seatMapEl.appendChild(rowEl);
  });
}

// Clicking an available seat instantly reserves it for 10 minutes.
// Clicking a seat you're already holding releases it immediately.
async function toggleSeat(seatId) {
  errorEl.textContent = '';

  if (heldSeatIds.has(seatId)) {
    heldSeatIds.delete(seatId);
    renderSeats();
    updateSummary();
    if (heldSeatIds.size === 0) {
      holdToken = null;
      clearInterval(timerInterval);
      timerEl.classList.add('hidden');
      checkoutForm.classList.add('hidden');
    }
    try {
      await fetch('/api/holds/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdToken, seatId }),
      });
    } catch (err) {
      console.error('Release failed:', err);
    }
    return;
  }

  // Optimistic update: show it as reserved immediately, confirm with the
  // server in the background. Only roll back if the request actually fails
  // (e.g. someone else grabbed it a split second earlier).
  heldSeatIds.add(seatId);
  checkoutForm.classList.remove('hidden');
  timerEl.classList.remove('hidden');
  renderSeats();
  updateSummary();

  try {
    const res = await fetch('/api/holds/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showId: SHOW_ID, seatId, holdToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not reserve that seat');

    holdToken = data.holdToken;
    holdExpiresAt = new Date(data.expiresAt);
    startTimer();
  } catch (err) {
    heldSeatIds.delete(seatId);
    errorEl.textContent = err.message;
    if (heldSeatIds.size === 0) {
      checkoutForm.classList.add('hidden');
      timerEl.classList.add('hidden');
    }
    renderSeats();
    updateSummary();
    loadSeats(); // refresh in case someone else just took it
  }
}

function updateSummary() {
  if (heldSeatIds.size === 0) {
    summaryEl.textContent = 'Tap a seat to reserve it — held for 10 minutes';
    return;
  }
  const chosen = seats.filter((s) => heldSeatIds.has(s.id));
  const total = chosen.reduce((sum, s) => sum + s.price_cents, 0);
  summaryEl.textContent = `${chosen.map((s) => s.label).join(', ')} — €${(total / 100).toFixed(2)}`;
}

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const msLeft = holdExpiresAt - new Date();
    if (msLeft <= 0) {
      clearInterval(timerInterval);
      timerEl.textContent = 'Hold expired — please reselect your seats.';
      checkoutForm.classList.add('hidden');
      holdToken = null;
      heldSeatIds.clear();
      loadSeats();
      return;
    }
    const mins = Math.floor(msLeft / 60000);
    const secs = Math.floor((msLeft % 60000) / 1000);
    timerEl.textContent = `Seats held — complete payment within ${mins}:${String(secs).padStart(2, '0')}`;
  }, 1000);
}

payBtn.addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  if (!email) { errorEl.textContent = 'Enter an email address.'; return; }
  errorEl.textContent = '';
  payBtn.disabled = true;
  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdToken, email, showId: SHOW_ID }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start checkout');
    window.location.href = data.url; // redirect to Stripe Checkout
  } catch (err) {
    errorEl.textContent = err.message;
    payBtn.disabled = false;
  }
});

loadShow();
loadSeats();
setInterval(() => { if (!holdToken) loadSeats(); }, 5000); // keep seat map fresh while browsing
