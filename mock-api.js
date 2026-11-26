/* In-browser replacement for the Java REST backend. Same endpoints, same rules, same JSON.
   Everything lives in these variables, so a page refresh starts from the beginning. */
(() => {
  const TYPES = {STANDARD: {label: 'Standard', rate: 2500, cap: 2}, DELUXE: {label: 'Deluxe', rate: 4500, cap: 3}, SUITE: {label: 'Suite', rate: 9000, cap: 4}};
  const PROMOS = {WELCOME10: 10, FESTIVE15: 15};
  const GST = 0.12, LONG_STAY = 5, FREE_CANCEL_DAYS = 2, BREAKFAST = 500;
  const round2 = v => Math.round(v * 100) / 100;
  const iso = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const today = () => iso(new Date());
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const err = (status, msg) => { throw {status, msg}; };

  // ---- state ----
  const rooms = [];
  [[1, 5, 'STANDARD'], [2, 4, 'DELUXE'], [3, 3, 'SUITE']].forEach(([f, n, type]) => {
    for (let i = 1; i <= n; i++) rooms.push({number: `${f}0${i}`, type, floor: f, maintenance: false, bookings: []});
  });
  const bookings = [];
  const users = {admin: {username: 'admin', password: 'admin123', fullName: 'Hotel Manager', phone: '', role: 'ADMIN'}};
  let current = null, nextId = 1000;

  // ---- rules ----
  const active = b => b.status === 'CONFIRMED';
  const overlaps = (b, i, o) => i < b.checkOut && o > b.checkIn;
  const isFree = (r, i, o) => !r.maintenance && !r.bookings.some(b => active(b) && overlaps(b, i, o));
  const occupied = (r, d) => r.bookings.some(b => active(b) && overlaps(b, d, addDays(d, 1)));
  const nights = b => daysBetween(b.checkIn, b.checkOut);

  function validateDates(i, o) {
    if (!i || !o) err(400, 'Check-in and check-out dates are required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(i) || !/^\d{4}-\d{2}-\d{2}$/.test(o)) err(400, 'Invalid date');
    if (i < today()) err(400, 'Check-in cannot be in the past');
    if (!(o > i)) err(400, 'Check-out must be after check-in');
  }
  function parseType(t) { const k = String(t || '').trim().toUpperCase(); if (!TYPES[k]) err(400, 'Unknown room type: ' + t); return k; }
  function promoPct(code) {
    if (!code || !String(code).trim()) return 0;
    const p = PROMOS[String(code).trim().toUpperCase()];
    if (p === undefined) err(400, 'Invalid promo code');
    return p;
  }
  function checkGuests(type, g) { if (!(g >= 1 && g <= TYPES[type].cap)) err(400, `${TYPES[type].label} rooms sleep 1 to ${TYPES[type].cap} guests`); }

  function price(id, name, room, type, n, guests, breakfast, promo) {
    const t = TYPES[type], charge = t.rate * n;
    const longStay = n >= LONG_STAY ? round2(charge * 0.10) : 0;
    const promoDisc = round2(charge * promoPct(promo) / 100);
    const bf = breakfast ? BREAKFAST * guests * n : 0;
    const taxable = charge - longStay - promoDisc + bf, gst = round2(taxable * GST);
    return {bookingId: id, customerName: name, room, typeLabel: t.label, nights: n, guests, rate: t.rate, roomCharge: charge,
      breakfast: bf, longStayDiscount: longStay, promoDiscount: promoDisc, promoCode: promo ? String(promo).trim().toUpperCase() : '',
      gst, total: round2(taxable + gst)};
  }
  const roomJson = r => ({number: r.number, type: r.type, typeLabel: TYPES[r.type].label, floor: r.floor, rate: TYPES[r.type].rate, capacity: TYPES[r.type].cap,
    status: r.maintenance ? 'MAINTENANCE' : occupied(r, today()) ? 'OCCUPIED' : 'VACANT'});
  const bookingJson = b => ({id: b.id, owner: b.owner, customerName: b.customerName, phone: b.phone, room: b.room, type: b.type, typeLabel: TYPES[b.type].label,
    checkIn: b.checkIn, checkOut: b.checkOut, nights: nights(b), guests: b.guests, breakfast: b.breakfast, promoCode: b.promoCode,
    status: b.status, cancellationFee: b.cancellationFee, createdAt: b.createdAt});
  const userJson = u => ({username: u.username, fullName: u.fullName, phone: u.phone, role: u.role});
  const billOf = b => price(b.id, b.customerName, b.room, b.type, nights(b), b.guests, b.breakfast, b.promoCode);

  function getFor(id) {
    const b = bookings.find(x => x.id === id);
    if (!b || (current.role !== 'ADMIN' && b.owner !== current.username)) err(404, `Booking ${id} not found`);
    return b;
  }
  const phoneOk = p => /^[0-9+\- ]{7,15}$/.test(p || '');
  const admin = () => { if (current.role !== 'ADMIN') err(403, 'Admin access required'); };

  // ---- endpoints ----
  function route(method, path, q, f) {
    const p = path.split('/'), r = p[2], get = method === 'GET', post = method === 'POST';
    if (post && r === 'login') {
      const u = users[String(f.username || '').trim().toLowerCase()];
      if (!u || u.password !== f.password) err(401, 'Invalid username or password');
      current = u; return [200, userJson(u)];
    }
    if (post && r === 'register') {
      const un = String(f.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(un)) err(400, 'Username: 3-20 letters, digits or underscore');
      if (!f.password || f.password.length < 6) err(400, 'Password must be at least 6 characters');
      if (!f.fullName || !f.fullName.trim()) err(400, 'Full name is required');
      if (!phoneOk(f.phone)) err(400, 'Enter a valid phone number');
      if (users[un]) err(409, 'Username already taken');
      users[un] = {username: un, password: f.password, fullName: f.fullName.trim(), phone: f.phone.trim(), role: 'GUEST'};
      current = users[un]; return [201, userJson(current)];
    }
    if (post && r === 'logout') { current = null; return [200, {ok: true}]; }
    if (!current) err(401, 'Please sign in');

    if (get && r === 'me') return [200, userJson(current)];
    if (get && r === 'rooms') return [200, rooms.map(roomJson)];
    if (post && r === 'rooms' && p[4] === 'maintenance') {
      admin();
      const room = rooms.find(x => x.number === p[3]); if (!room) err(404, `Room ${p[3]} not found`);
      room.maintenance = String(f.on) === 'true'; return [200, rooms.map(roomJson)];
    }
    if (get && r === 'availability') {
      validateDates(q.checkIn, q.checkOut);
      const t = q.type ? parseType(q.type) : null;
      return [200, rooms.filter(x => (!t || x.type === t) && isFree(x, q.checkIn, q.checkOut)).map(roomJson)];
    }
    if (get && r === 'quote') {
      const t = parseType(q.type); validateDates(q.checkIn, q.checkOut);
      const g = Number(q.guests || 1); checkGuests(t, g);
      return [200, price(0, '', '', t, daysBetween(q.checkIn, q.checkOut), g, q.breakfast === 'true', q.promo)];
    }
    if (get && r === 'stats') {
      admin();
      const t = today(); let occ = 0, maint = 0, active_ = 0, cancelled = 0, revenue = 0;
      const byType = Object.keys(TYPES).map(k => ({label: TYPES[k].label, rooms: 0, occupied: 0, k}));
      rooms.forEach(x => { const bt = byType.find(y => y.k === x.type); bt.rooms++;
        if (x.maintenance) maint++; else if (occupied(x, t)) { occ++; bt.occupied++; } });
      bookings.forEach(b => { if (active(b)) { active_++; revenue += billOf(b).total; } else { cancelled++; revenue += b.cancellationFee; } });
      const usable = rooms.length - maint;
      return [200, {totalRooms: rooms.length, maintenanceRooms: maint, occupiedTonight: occ, occupancyPct: usable ? Math.round(occ * 100 / usable) : 0,
        activeBookings: active_, cancelledBookings: cancelled, revenue: round2(revenue), byType: byType.map(({k, ...x}) => x)}];
    }
    if (r === 'bookings') {
      if (p.length === 3 && get) return [200, bookings.filter(b => current.role === 'ADMIN' || b.owner === current.username).sort((a, b) => b.id - a.id).map(bookingJson)];
      if (p.length === 3 && post) {
        const type = parseType(f.type), name = (f.customerName || '').trim() || current.fullName, phone = (f.phone || '').trim() || current.phone;
        const g = Number(f.guests || 1);
        if (!name) err(400, 'Guest name is required');
        if (!phoneOk(phone)) err(400, 'Enter a valid phone number');
        validateDates(f.checkIn, f.checkOut); checkGuests(type, g); promoPct(f.promo);
        const room = rooms.find(x => x.type === type && isFree(x, f.checkIn, f.checkOut));
        if (!room) err(409, `No ${TYPES[type].label} rooms available for the selected dates`);
        const b = {id: ++nextId, owner: current.username, customerName: name, phone, room: room.number, type, checkIn: f.checkIn, checkOut: f.checkOut,
          guests: g, breakfast: String(f.breakfast) === 'true', promoCode: f.promo ? String(f.promo).trim().toUpperCase() : '',
          status: 'CONFIRMED', cancellationFee: 0, createdAt: new Date().toISOString().slice(0, 19)};
        room.bookings.push(b); bookings.push(b); return [201, bookingJson(b)];
      }
      if (p.length === 5 && post && p[4] === 'cancel') {
        const b = getFor(Number(p[3]));
        if (!active(b)) err(409, `Booking ${b.id} is already cancelled`);
        if (b.checkIn < today()) err(409, 'Stays that have started cannot be cancelled');
        b.cancellationFee = daysBetween(today(), b.checkIn) >= FREE_CANCEL_DAYS ? 0 : TYPES[b.type].rate;
        b.status = 'CANCELLED'; return [200, bookingJson(b)];
      }
      if (p.length === 5 && get && p[4] === 'bill') {
        const b = getFor(Number(p[3]));
        if (!active(b)) err(409, `Booking ${b.id} is cancelled; no bill to generate`);
        return [200, billOf(b)];
      }
    }
    err(404, 'Not found');
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), location.origin);
    if (!u.pathname.startsWith('/api')) return realFetch(url, opts);
    let status, data;
    try {
      [status, data] = route((opts.method || 'GET').toUpperCase(), u.pathname, Object.fromEntries(u.searchParams), opts.body ? JSON.parse(opts.body) : {});
    } catch (e) {
      if (e && e.status) { status = e.status; data = {error: e.msg}; } else { console.error(e); status = 500; data = {error: 'Unexpected error'}; }
    }
    return new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});
  };
})();
