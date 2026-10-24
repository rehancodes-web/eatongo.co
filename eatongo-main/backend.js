/* eatongo backend layer — add <script src="backend.js"></script> just before </body>
   - Generates a unique auth code + order no + token per order
   - Saves orders (Firebase Realtime DB, or localStorage fallback for same-browser testing)
   - Vendor dashboard / order manager update in real time, status changes sync back to customer */
(() => {
  'use strict';

  /* ====== 1. PASTE YOUR FIREBASE CONFIG HERE (leave databaseURL empty = local test mode) ====== */
const FIREBASE_CONFIG = {

  apiKey: "AIzaSyDQy3PGM914RE8A8Y50dHxjsVpeBDsJLZw",

  authDomain: "eatongohh.firebaseapp.com",

  databaseURL: "https://eatongohh-default-rtdb.asia-southeast1.firebasedatabase.app",

  projectId: "eatongohh",

  storageBucket: "eatongohh.firebasestorage.app",

  messagingSenderId: "768793879173",

  appId: "1:768793879173:web:d83a699ba459400d7a3fec",

  measurementId: "G-PL8P8QBSYG"

};

  /* ========================================================================================== */

  const USE_FIREBASE = !!FIREBASE_CONFIG.databaseURL;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date().toLocaleDateString('en-CA');
  const timeStr = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

  /* auth code: 2 letters + 2 digits (no look-alike chars), e.g. KT47 */
  const LET = 'ABCDEFGHJKLMNPQRSTUVWXYZ', DIG = '23456789';
  const pick = s => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const genAuth = () => pick(LET) + pick(LET) + pick(DIG) + pick(DIG);

  /* ---------- storage adapters ---------- */
  function localStore() {
    const K = 'eatongo_db', subs = [];
    const read = () => { try { return JSON.parse(localStorage.getItem(K)) || {}; } catch (e) { return {}; } };
    const list = () => Object.values(read().orders || {});
    const emit = () => subs.forEach(f => f(list()));
    const write = d => { localStorage.setItem(K, JSON.stringify(d)); emit(); };
    addEventListener('storage', e => { if (e.key === K) emit(); });
    return {
      async counters(day) {
        const d = read(), m = d.meta || {};
        m.orderSeq = (m.orderSeq || 1042) + 1;
        if (m.tokenDay !== day) { m.tokenDay = day; m.tokenSeq = 100; }
        m.tokenSeq++; d.meta = m; write(d);
        return { no: m.orderSeq, token: m.tokenSeq };
      },
      async claimAuth(day) {
        const d = read(); d.auth = d.auth || {}; d.auth[day] = d.auth[day] || {};
        for (let i = 0; i < 50; i++) { const c = genAuth(); if (!d.auth[day][c]) { d.auth[day][c] = 1; write(d); return c; } }
        throw new Error('Could not generate auth code');
      },
      async save(o) { const d = read(); d.orders = d.orders || {}; d.orders[o.id] = o; write(d); },
      async update(id, p) { const d = read(); if (d.orders && d.orders[id]) { Object.assign(d.orders[id], p); write(d); } },
      subscribe(f) { subs.push(f); f(list()); },
      async exportAll() { return read(); }
    };
  }

  const loadScript = src => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => rej(new Error('Failed to load ' + src)); document.head.appendChild(s);
  });

  async function firebaseStore() {
    const v = '10.12.2';
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-database-compat.js`);
    firebase.initializeApp(FIREBASE_CONFIG);
    const db = firebase.database();
    return {
      async counters(day) {
        const r = await db.ref('meta').transaction(m => {
          m = m || {};
          m.orderSeq = (m.orderSeq || 1042) + 1;
          if (m.tokenDay !== day) { m.tokenDay = day; m.tokenSeq = 100; }
          m.tokenSeq = (m.tokenSeq || 100) + 1;
          return m;
        });
        const m = r.snapshot.val();
        return { no: m.orderSeq, token: m.tokenSeq };
      },
      async claimAuth(day) {          // atomic: a code can only be claimed once per day
        for (let i = 0; i < 50; i++) {
          const c = genAuth();
          const r = await db.ref(`authCodes/${day}/${c}`).transaction(v => (v === null ? true : undefined));
          if (r.committed) return c;
        }
        throw new Error('Could not generate auth code');
      },
      save: o => db.ref('orders/' + o.id).set(o),
      update: (id, p) => db.ref('orders/' + id).update(p),
      subscribe(f) { db.ref('orders').on('value', s => f(Object.values(s.val() || {}))); },
      async exportAll() { return (await db.ref().once('value')).val(); }
    };
  }

  const ready = (async () => {
    try { return USE_FIREBASE ? await firebaseStore() : localStore(); }
    catch (e) {
      console.error(e);
      setTimeout(() => toast('<b>Backend error.</b> Check Firebase config. Using local test mode.'), 500);
      return localStore();
    }
  })();

  /* ---------- state ---------- */
  let store = null, orders = [], known = null;
  let mineId = sessionStorage.getItem('eatongo_order') || null, lastMineStatus = null;
  let opsTab = 'live', queueTab = 'live';
  const NEXT = { new: 'preparing', preparing: 'ready', ready: 'collected' };
  const FLOW_INDEX = { new: 0, preparing: 2, ready: 3, collected: 4 };

  const isLive = o => o.status !== 'collected' && o.pickup !== 'pre';
  const isPre = o => o.status !== 'collected' && o.pickup === 'pre';
  const isDone = o => o.status === 'collected';
  const itemsText = o => (o.items || []).map(i => `${esc(i.name)} × ${i.qty}`).join(', ');
  const metaText = o => `${esc(o.customer)} · ₹${o.total} · Paid · ${timeStr(o.createdAt)}${o.pickup === 'pre' ? ' · Pre-order ' + esc(o.pickupTime) : ''}`;

  /* ---------- customer: place order ---------- */
  document.addEventListener('click', e => {
    if (e.target.id !== 'checkoutBtn') return;
    // existing handler closes the cart only when validation passed
    if ($('#cartPanel').classList.contains('open')) return;
    placeOrder();
  });

  async function placeOrder() {
    const snapshot = { ...cart };
    const items = Object.entries(snapshot).filter(([, q]) => q > 0)
      .map(([i, q]) => ({ name: foods[i].name, qty: q, price: foods[i].price }));
    if (!items.length) return;

    let name = (sessionStorage.getItem('eatongoCustomerName') || '').trim();
    if (!name) {
      name = (prompt('Your name for this order?', '') || '').trim() || 'Guest';
      sessionStorage.setItem('eatongoCustomerName', name);
    }
    const pre = selectedPickup === 'pre';
    const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);

    cart = {}; renderCart();
    $('.pass-token').textContent = '…'; $('.pass-auth').textContent = '…';

    try {
      store = store || await ready;
      const day = today();
      const [c, auth] = await Promise.all([store.counters(day), store.claimAuth(day)]);
      const order = {
        id: 'HS-' + c.no, no: c.no, token: String(c.token), auth,
        customer: name, items, subtotal, total: Math.round(subtotal * 1.05),
        pickup: pre ? 'pre' : 'now',
        pickupTime: pre ? `${+preorderHour}:${preorderMinute} ${preorderPeriod}` : null,
        status: 'new', paid: true, createdAt: Date.now(), day
      };
      await store.save(order);
      mineId = order.id; lastMineStatus = 'new';
      sessionStorage.setItem('eatongo_order', mineId);
      paintMine(order);
      toast(`<b>Payment verified.</b> Token ${order.token} · Code #${order.auth}`);
    } catch (err) {
      console.error(err);
      cart = snapshot; renderCart();
      toast('<b>Could not place order.</b> Please try again.');
    }
  }

  function paintMine(o) {
    $('.pass-token').textContent = o.token;
    $('.pass-auth').textContent = '#' + o.auth;
    $('#trackingSummary').textContent = `Order ${o.id} · ` +
      (o.pickup === 'pre' ? `Pre-order pickup today at ${o.pickupTime}` : 'Estimated pickup in ~8 minutes');
    statusIndex = FLOW_INDEX[o.status] ?? 0; renderFlow();
  }

  /* ---------- vendor: render ---------- */
  const LABEL = { new: 'Accept', preparing: 'Mark ready', ready: 'Complete' };
  const LABEL_OPS = { new: 'Accept order', preparing: 'Mark ready', ready: 'Complete pickup' };
  const row = o => `<div class="order-row"><div class="order-no">#${o.no}</div><div><h3>${itemsText(o)}</h3><p>${metaText(o)}<span class="order-auth" aria-label="Authentication code">#${esc(o.auth)}</span></p></div><button class="status ${o.status}" data-oid="${esc(o.id)}">${LABEL[o.status]}</button></div>`;
  const card = o => `<article class="ops-card"><div class="ops-card-top"><div class="ops-number">#${o.no}</div><div class="ops-auth">#${esc(o.auth)}</div></div><h3>${itemsText(o)}</h3><p>${metaText(o)}</p>${o.status === 'collected' ? '<button class="status ready" disabled>Collected ✓</button>' : `<button class="status ${o.status}" data-oid="${esc(o.id)}">${LABEL_OPS[o.status]}</button>`}</article>`;
  const EMPTY_ROW = '<p class="sub" style="padding:14px">No orders here yet. New orders appear instantly.</p>';
  const EMPTY_CARD = '<div class="ops-empty"><b>No orders here</b>The next order will appear automatically.</div>';

  const byTab = t => t === 'live' ? orders.filter(isLive) : t === 'pre' ? orders.filter(isPre) : orders.filter(isDone).slice().reverse();

  window.renderOps = (t = 'live') => { opsTab = t; renderVendor(); };

  function renderVendor() {
    const live = byTab('live'), pre = byTab('pre'), done = byTab('completed');
    const active = orders.filter(o => o.status !== 'collected');

    // phone order manager
    $$('[data-ops-tab]').forEach(b => {
      const t = b.dataset.opsTab;
      b.classList.toggle('active', t === opsTab);
      b.textContent = { live: `Live · ${live.length}`, pre: `Pre-orders · ${pre.length}`, completed: `Completed · ${done.length}` }[t];
    });
    const opsList = byTab(opsTab);
    $('#opsOrderList').innerHTML = opsList.length ? opsList.map(card).join('') : EMPTY_CARD;

    // dashboard
    $('#dashboardOrders').innerHTML = active.length ? active.slice(0, 3).map(row).join('') : EMPTY_ROW;
    const q = byTab(queueTab);
    $('#fullQueue').innerHTML = q.length ? q.map(row).join('').replace(/<button class="status ready" data-oid="[^"]*">Complete<\/button>(?=<\/div>$)/, m => m) : EMPTY_ROW;
    $$('#vpage-queue .tabs .tab').forEach((b, i) => {
      const t = ['live', 'pre', 'completed'][i];
      b.classList.toggle('active', t === queueTab);
      b.textContent = { live: `Order now · ${live.length}`, pre: `Pre-orders · ${pre.length}`, completed: `Completed · ${done.length}` }[t];
      b.onclick = () => { queueTab = t; renderVendor(); };
    });
    const liveBadge = $('#vpage-queue .live'); if (liveBadge) liveBadge.textContent = `${active.length} active`;

    // overview stats
    const td = orders.filter(o => o.day === today());
    const sales = td.reduce((a, o) => a + o.total, 0);
    const recent = orders.filter(o => Date.now() - o.createdAt < 15 * 60000).length;
    const st = $$('#vpage-overview .stat');
    if (st.length >= 4) {
      const set = (i, v, sub) => { st[i].querySelector('strong').textContent = v; st[i].lastElementChild.textContent = sub; };
      set(0, '₹' + sales.toLocaleString('en-IN'), 'Updated live');
      set(1, String(td.length), 'today');
      set(2, '₹' + (td.length ? Math.round(sales / td.length) : 0), 'per order');
      set(3, recent >= 8 ? 'High' : recent >= 4 ? 'Medium' : 'Low', `${recent} orders / 15 min`);
    }
  }

  /* ---------- vendor: update order status ---------- */
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-oid]');
    if (!b || b.disabled) return;
    const o = orders.find(x => x.id === b.dataset.oid);
    if (!o || !NEXT[o.status]) return;
    b.disabled = true;
    try { await (store || await ready).update(o.id, { status: NEXT[o.status], updatedAt: Date.now() }); }
    catch (err) { console.error(err); toast('<b>Update failed.</b> Try again.'); b.disabled = false; }
  });

  /* ---------- vendor: verify pickup ---------- */
  function verify() {
    const q = $('#tokenInput').value.trim().toUpperCase().replace(/^#/, '');
    const r = $('#verifyResult'), d = today();
    const o = [...orders].reverse().find(x => x.id.toUpperCase() === q || String(x.no) === q ||
      (x.day === d && (x.auth === q || String(x.token) === q)));
    const bad = m => `<div class="success" style="background:#ffe5e2;color:#a43d32">${m}</div>`;
    if (!q) { r.innerHTML = ''; return; }
    if (!o) { r.innerHTML = bad('Order not found. Check the token or auth code.'); return; }
    if (o.status === 'collected') { r.innerHTML = bad(`${esc(o.id)} was already collected.`); return; }
    const ok = o.status === 'ready';
    r.innerHTML = `<div class="success" ${ok ? '' : 'style="background:#fff1d9;color:#9b5b0a"'}>${ok ? '✓ Verified' : '⏳ Not ready yet'} · Paid · ${esc(o.customer)} · ${itemsText(o)} · Token ${esc(o.token)} · Code #${esc(o.auth)}</div>` +
      (ok ? `<button class="primary dark" data-oid="${esc(o.id)}" style="max-width:520px">Complete pickup</button>` : '');
  }
  $('#verifyToken').onclick = verify;
  $('#tokenInput').placeholder = 'Order no., token or auth code';
  $('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') verify(); });

  /* ---------- realtime listener (both sides) ---------- */
  function beep() {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
      o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.value = .08; o.start();
      setTimeout(() => { o.stop(); a.close(); }, 180);
    } catch (e) { }
  }

  function onOrders(list) {
    const fresh = known === null ? [] : list.filter(o => !known.has(o.id));
    known = new Set(list.map(o => o.id));
    orders = list.slice().sort((a, b) => a.createdAt - b.createdAt);
    renderVendor();

    const vendorView = document.body.classList.contains('vendor-mode') || document.body.classList.contains('ops-mode');
    if (vendorView) fresh.forEach(o => { toast(`<b>New order ${esc(o.id)}</b> · ${esc(o.customer)} · #${esc(o.auth)}`); beep(); });

    const mine = orders.find(o => o.id === mineId);
    if (mine) {
      paintMine(mine);
      if (lastMineStatus && lastMineStatus !== mine.status) {
        if (mine.status === 'preparing') toast('<b>Order accepted.</b> The kitchen is preparing it.');
        if (mine.status === 'ready') toast(`<b>Order ready!</b> Show code #${esc(mine.auth)} at the counter.`);
        if (mine.status === 'collected') toast('<b>Collected.</b> Enjoy your meal!');
      }
      lastMineStatus = mine.status;
    }
  }

  const adv = $('#advanceCustomer'); if (adv) adv.style.display = 'none';   // real status now comes from the vendor

  ready.then(s => { store = s; s.subscribe(onOrders); });

  /* optional: run eatongoExport() in the console to download all data as orders.json */
  window.eatongoExport = async () => {
    const data = await (store || await ready).exportAll();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'orders.json'; a.click();
  };
})();
