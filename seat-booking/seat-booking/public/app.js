const SHOW_ID = 1; // demo: single show. Extend to read from URL query for multi-show sites.

let seats = [];
let selected = new Set();
let holdToken = null;
let holdExpiresAt = null;
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const summaryEl = document.getElementById('selection-summary');
const holdBtn = document.getElementById('hold-btn');
const timerEl = document.getElementById('timer');
const checkoutForm = document.getElementById('checkout-form');
const payBtn = document.getElementById('pay-btn');
const errorEl = document.getElementById('error-msg');

async function loadShow() {
  const show = await fetch(`/api/shows/${SHOW_ID}`).then((r) => r.json());
  document.getElementById('show-name').textContent = show.name;
  document.getElementById('show-meta').textContent =
    `${show.venue} — ${new Date(show.starts_at).toLocaleString()}`;
}

async function loadSeats() {
  seats = await fetch(`/api/shows/${SHOW_ID}/seats`).then((r) => r.json());
  renderSeats();
}

function renderSeats() {
  const rows = {};
  seats.forEach((s) => { (rows[s.row_name] ||= []).push(s); });

  seatMapEl.innerHTML = '';
  Object.keys(rows).sort().forEach((rowName) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowName;
    rowEl.appendChild(label);

    rows[rowName].sort((a, b) => a.seat_number - b.seat_number).forEach((seat) => {
      const btn = document.createElement('button');
      btn.className = 'seat';
      btn.textContent = seat.seat_number;
      btn.title = `${seat.label} — $${(seat.price_cents / 100).toFixed(2)}`;
      if (selected.has(seat.id)) btn.classList.add('selected');
      else if (seat.status !== 'available') btn.classList.add(seat.status);

      if (seat.status === 'available' || selected.has(seat.id)) {
        btn.addEventListener('click', () => toggleSeat(seat.id));
      } else {
        btn.disabled = true;
      }
      rowEl.appendChild(btn);
    });
    seatMapEl.appendChild(rowEl);
  });
}

function toggleSeat(seatId) {
  if (holdToken) return; // locked in once a hold is active
  if (selected.has(seatId)) selected.delete(seatId);
  else selected.add(seatId);
  updateSummary();
  renderSeats();
}

function updateSummary() {
  if (selected.size === 0) {
    summaryEl.textContent = 'Select your seats above';
    holdBtn.disabled = true;
    return;
  }
  const chosen = seats.filter((s) => selected.has(s.id));
  const total = chosen.reduce((sum, s) => sum + s.price_cents, 0);
  summaryEl.textContent = `${chosen.map((s) => s.label).join(', ')} — $${(total / 100).toFixed(2)}`;
  holdBtn.disabled = false;
}

holdBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  holdBtn.disabled = true;
  try {
    const res = await fetch('/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showId: SHOW_ID, seatIds: [...selected] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not reserve seats');

    holdToken = data.holdToken;
    holdExpiresAt = new Date(data.expiresAt);
    holdBtn.classList.add('hidden');
    checkoutForm.classList.remove('hidden');
    timerEl.classList.remove('hidden');
    startTimer();
  } catch (err) {
    errorEl.textContent = err.message;
    holdBtn.disabled = false;
  }
});

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const msLeft = holdExpiresAt - new Date();
    if (msLeft <= 0) {
      clearInterval(timerInterval);
      timerEl.textContent = 'Hold expired — please reselect your seats.';
      checkoutForm.classList.add('hidden');
      holdToken = null;
      selected.clear();
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
