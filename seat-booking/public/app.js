const SHOW_ID = new URLSearchParams(location.search).get('show');
if (!SHOW_ID) {
  location.href = '/shows.html';
  throw new Error('No show selected — redirecting.'); // stop this script from running further
}

let seats = [];
let heldSeatIds = new Set(); // seats *I* am currently holding
// The reservation token is created up front, in the browser, and sent with EVERY
// click. Before, it only existed after the first server reply — so when someone
// clicked several seats quickly, the later clicks went out with no token, the
// server made a separate reservation for each, and checkout only saw the last
// group (e.g. paying for 3 of 5 seats).
function newToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
let holdToken = newToken();
let holdExpiresAt = null;
const attendeeNames = {}; // seatId -> name typed so far
let timerInterval = null;

const seatMapEl = document.getElementById('seat-map');
const summaryEl = document.getElementById('selection-summary');
const timerEl = document.getElementById('timer');
const checkoutForm = document.getElementById('checkout-form');
const payBtn = document.getElementById('pay-btn');
const errorEl = document.getElementById('error-msg');
const nameFieldsEl = document.getElementById('name-fields');

async function loadShow() {
  const show = await fetch(`/api/shows/${SHOW_ID}`).then((r) => r.json());
  document.getElementById('show-name').textContent = show.name;
  const date = new Date(show.starts_at);
  const dateStr = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Malta' });
  const whenStr = show.time_tbc ? `${dateStr} — Time TBC` : `${dateStr}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Malta' })}`;
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

// Seats are numbered 1-20 across each row (1-10 left of the aisle, 11-20 right).
// Rows A, B and N don't have every seat, so missing numbers are drawn as empty
// spacers — that keeps every row lined up exactly like the printed seating plan.
function makeSpacer() {
  const d = document.createElement('div');
  d.className = 'seat-spacer';
  return d;
}
function addSeatSlots(rowEl, rowSeats, from, to) {
  const byNumber = {};
  rowSeats.forEach((s) => { byNumber[s.seat_number] = s; });
  for (let n = from; n <= to; n++) {
    rowEl.appendChild(byNumber[n] ? makeSeatButton(byNumber[n]) : makeSpacer());
  }
}

function renderSeats() {
  const rows = {};
  seats.forEach((s) => { (rows[s.row_name] ||= []).push(s); });

  seatMapEl.innerHTML = '';
  Object.keys(rows).sort().forEach((rowName) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';



    rowEl.appendChild(makeRowLabel(rowName));
    addSeatSlots(rowEl, rows[rowName], 1, 10);

    const gap = document.createElement('div');
    gap.className = 'aisle-gap';
    rowEl.appendChild(gap);

    addSeatSlots(rowEl, rows[rowName], 11, 20);

    seatMapEl.appendChild(rowEl);
  });
}

// Clicking an available seat instantly reserves it for 10 minutes.
// Clicking a seat you're already holding releases it immediately.
async function toggleSeat(seatId) {
  errorEl.textContent = '';

  if (heldSeatIds.has(seatId)) {
    // Capture the token before any local state changes below — releasing
    // your last held seat clears holdToken on the client, and sending that
    // cleared value to the server instead of the real token made the server
    // reject the release (400) and leave the hold in the database forever,
    // which is why the seat stayed greyed out ("held") after deselecting it.
    const releaseToken = holdToken;
    heldSeatIds.delete(seatId);
    renderSeats();
    updateSummary();
    if (heldSeatIds.size === 0) {
      clearInterval(timerInterval);
      timerEl.classList.add('hidden');
      checkoutForm.classList.add('hidden');
    }
    try {
      await fetch('/api/holds/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdToken: releaseToken, seatId }),
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

// One "name" input per held seat, so every ticket gets its own QR code.
// Already-typed names are kept when seats are added/removed.
function renderNameFields() {
  const chosen = seats.filter((s) => heldSeatIds.has(s.id));
  const focusedId = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.seat : null;
  nameFieldsEl.innerHTML = '';
  chosen.forEach((s) => {
    const label = document.createElement('label');
    const tag = document.createElement('span');
    tag.textContent = s.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = 'Full name for this ticket';
    input.autocomplete = 'name';
    input.dataset.seat = s.id;
    input.value = attendeeNames[s.id] || '';
    input.addEventListener('input', () => { attendeeNames[s.id] = input.value; });
    label.append(tag, input);
    nameFieldsEl.appendChild(label);
    if (String(s.id) === focusedId) input.focus();
  });
}

function updateSummary() {
  renderNameFields();
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
      holdToken = newToken();
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
  const attendees = [...heldSeatIds].map((id) => ({ seatId: id, name: (attendeeNames[id] || '').trim() }));
  if (attendees.some((a) => !a.name)) { errorEl.textContent = 'Please enter a name for every ticket.'; return; }
  if (!email) { errorEl.textContent = 'Enter an email address.'; return; }
  errorEl.textContent = '';
  payBtn.disabled = true;
  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdToken, email, showId: SHOW_ID, attendees }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start checkout');
    window.location.href = data.url; // redirect to Stripe Checkout
  } catch (err) {
    errorEl.textContent = err.message;
    payBtn.disabled = false;
  }
});

// The booking panel is pinned to the bottom of the screen and grows when the
// name boxes appear. Keep the page's bottom padding equal to the panel's height
// so the seat rows at the bottom can always be scrolled up above the panel.
const panelEl = document.querySelector('.panel');
const wrapEl = document.querySelector('.wrap');
function syncPanelSpace() {
  wrapEl.style.paddingBottom = (panelEl.offsetHeight + 24) + 'px';
}
if (window.ResizeObserver) new ResizeObserver(syncPanelSpace).observe(panelEl);
window.addEventListener('resize', syncPanelSpace);
syncPanelSpace();

loadShow();
loadSeats();
setInterval(() => { if (heldSeatIds.size === 0) loadSeats(); }, 5000); // keep seat map fresh while browsing
