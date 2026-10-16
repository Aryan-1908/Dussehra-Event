/* Stand-in for the claude.ai runtime when Ravan Dahan is self-hosted.
   Provides window.claude.use('room' | 'db' | 'user') over one WebSocket to server.py. */
(function () {
  'use strict';
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} }
  };
  function rand(n) {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), x => a[x % a.length]).join('');
  }

  // Host key: read from ?host=..., then hide it from the address bar (the host shares this screen).
  const qs = new URLSearchParams(location.search);
  let hostKey = qs.get('host') || '';
  try {
    if (hostKey) { sessionStorage.setItem('rd.hostKey', hostKey); history.replaceState(null, '', location.pathname); }
    else hostKey = sessionStorage.getItem('rd.hostKey') || '';
  } catch {}

  let id = ls.get('rd.uid');
  if (!/^u_[A-Za-z0-9]{8,40}$/.test(id || '')) { id = 'u_' + rand(20); ls.set('rd.uid', id); }
  let name = ls.get('rd.name') || '';

  const S = { round: null, ws: null, connected: false, peer: null, isHost: false, names: {}, peers: Object.freeze([]), vows: [], presence: {} };
  const L = { topics: new Map(), peers: new Set(), conn: new Set(), vows: new Set() };
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });
  setTimeout(() => readyResolve(), 5000);

  function send(o) {
    if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(o)); return true; }
    return false;
  }
  function fireConn() { L.conn.forEach(fn => { try { fn(S.connected); } catch (e) { console.error(e); } }); }
  function fireVows() { L.vows.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }
  function setPeers(list) {
    const prev = new Map(S.peers.map(p => [p.peer, p]));
    const next = list.map(p => Object.freeze({
      peer: p.peer, by: p.by || null, isMe: p.by === id, sameTab: p.peer === S.peer,
      kind: 'viewer', guest: false, presence: Object.freeze(p.presence || {}), updatedAt: Date.now()
    }));
    const ids = new Set(next.map(p => p.peer));
    const joined = next.filter(p => !prev.has(p.peer));
    const left = [...prev.values()].filter(p => !ids.has(p.peer));
    S.peers = Object.freeze(next);
    const ch = { peers: S.peers, joined, left, updated: next.filter(p => prev.has(p.peer)) };
    L.peers.forEach(fn => { try { fn(ch); } catch (e) { console.error(e); } });
  }
  /* ---------- entry approval: waiting screen (players) + approval panel (host) ---------- */
  let gateEl = null, panelEl = null, pending = [], autoOn = false;
  function whenBody(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  function showGate(kind) {
    whenBody(() => {
      if (!gateEl) {
        gateEl = document.createElement('div');
        gateEl.style.cssText = 'position:fixed;inset:0;z-index:950;display:grid;place-items:center;padding:16px;background:#130d22;color:#f4ead7;font-family:Hind,system-ui,sans-serif;text-align:center';
        document.body.appendChild(gateEl);
      }
      const rej = kind === 'rejected';
      gateEl.innerHTML = '<div style="max-width:380px;display:grid;gap:10px"><div style="font-family:\'Yatra One\',Georgia,serif;font-size:30px;color:#f4a524;line-height:1.15">' +
        (rej ? 'The host did not let you in' : 'Waiting for the host') + '</div><div style="color:#b3a8c4;font-size:16px">' +
        (rej ? 'If this is a mistake, tell the host your name and refresh the page.' : 'You are in the queue. The game opens as soon as the host approves you. Keep this page open.') + '</div></div>';
      gateEl.hidden = false;
    });
  }
  function hideGate() { if (gateEl) gateEl.hidden = true; }
  function renderPanel() {
    if (!S.isHost) return;
    whenBody(() => {
      if (!panelEl) {
        panelEl = document.createElement('div');
        panelEl.style.cssText = 'position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:900;width:min(300px,calc(100vw - 24px));background:#1d1432;border:1px solid rgba(244,234,215,.2);border-radius:12px;padding:12px;color:#f4ead7;font:500 14px Hind,system-ui,sans-serif;display:grid;gap:8px;box-shadow:0 8px 28px rgba(0,0,0,.45)';
        document.body.appendChild(panelEl);
      }
      panelEl.textContent = '';
      const mk = (txt, bg, fn, dis) => {
        const b = document.createElement('button'); b.textContent = txt; b.disabled = !!dis;
        b.style.cssText = 'font:600 13px Hind,system-ui,sans-serif;border:0;border-radius:6px;padding:7px 10px;cursor:pointer;color:#130d22;background:' + bg + (dis ? ';opacity:.4' : '');
        b.onclick = fn; return b;
      };
      const head = document.createElement('div'); head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px';
      const title = document.createElement('b'); title.textContent = 'Entry requests (' + pending.length + ')';
      head.append(title, mk('Approve all', '#f4a524', () => send({ t: 'approve', all: true }), !pending.length));
      panelEl.append(head);
      const list = document.createElement('div'); list.style.cssText = 'display:grid;gap:6px;max-height:220px;overflow-y:auto';
      if (!pending.length) { const e = document.createElement('div'); e.style.color = '#b3a8c4'; e.textContent = autoOn ? 'Auto-approve is on. Everyone gets in.' : 'No one is waiting.'; list.append(e); }
      pending.forEach(p => {
        const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px;align-items:center';
        const n = document.createElement('span'); n.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere'; n.textContent = p.name || 'Someone';
        row.append(n, mk('Approve', '#6cc28a', () => send({ t: 'approve', ids: [p.id] })), mk('Reject', '#e8562a', () => send({ t: 'reject', ids: [p.id] })));
        list.append(row);
      });
      panelEl.append(list);
      const lab = document.createElement('label'); lab.style.cssText = 'display:flex;gap:8px;align-items:center;color:#b3a8c4;cursor:pointer';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = autoOn;
      cb.onchange = () => send({ t: 'auto', on: cb.checked });
      lab.append(cb, document.createTextNode('Auto-approve everyone'));
      panelEl.append(lab);
    });
  }
  function onMsg(m) {
    if (m.t === 'pending') { pending = m.list || []; autoOn = !!m.auto; renderPanel(); return; }
    if (m.t === 'rejected') { showGate('rejected'); return; }
    if (m.t === 'welcome') {
      S.peer = m.peer; S.isHost = !!m.isHost;
      pending = m.pending || []; autoOn = !!m.auto;
      if (m.approved === false) { S.connected = false; showGate('wait'); readyResolve(); return; }
      hideGate(); if (S.isHost) renderPanel();
      S.names = m.names || {}; S.vows = m.vows || []; S.round = m.round == null ? null : m.round;
      S.connected = true;
      if (Object.keys(S.presence).length) send({ t: 'presence', patch: S.presence });
      setPeers(m.peers || []); fireConn(); fireVows(); readyResolve();
    } else if (m.t === 'peers') setPeers(m.peers || []);
    else if (m.t === 'names') S.names = m.names || {};
    else if (m.t === 'round') { S.round = m.round; }
    else if (m.t === 'vows') { S.vows = m.vows || []; fireVows(); }
    else if (m.t === 'msg') {
      const set = L.topics.get(m.topic); if (!set) return;
      const msg = Object.freeze({ topic: m.topic, data: m.data, peer: m.peer, by: m.by || null, isMe: m.by === id, sameTab: m.peer === S.peer, kind: 'viewer', guest: false });
      set.forEach(fn => { try { fn(msg); } catch (e) { console.error(e); } });
    }
  }
  function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    S.ws = ws;
    ws.onopen = () => send({ t: 'hello', id, name, hostKey });
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m && typeof m === 'object') onMsg(m); };
    ws.onclose = () => {
      const was = S.connected; S.connected = false; if (was) fireConn();
      setTimeout(connect, 1500 + Math.random() * 1500);
    };
  }
  connect();

  /* ---------- namespaces ---------- */
  function color(k) { let h = 0; for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return 'hsl(' + (h % 360) + ' 65% 62%)'; }
  function avatar(k, n) {
    const ini = (n || '?').split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase().replace(/[^\p{L}\p{N}?]/gu, '') || '?';
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='32' fill='" + color(k) +
      "'/><text x='32' y='41' font-family='sans-serif' font-size='26' font-weight='700' text-anchor='middle' fill='#130d22'>" + ini + "</text></svg>";
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  const room = {
    emit(topic, data) { send({ t: 'emit', topic, data }); return Promise.resolve(); },
    on(topic, fn) {
      if (!L.topics.has(topic)) L.topics.set(topic, new Set());
      L.topics.get(topic).add(fn);
      return () => L.topics.get(topic).delete(fn);
    },
    presence(patch) {
      for (const k in patch) { if (patch[k] === null) delete S.presence[k]; else S.presence[k] = patch[k]; }
      send({ t: 'presence', patch }); return Promise.resolve();
    },
    peers() { return S.peers; },
    onPeers(fn) { L.peers.add(fn); queueMicrotask(() => fn({ peers: S.peers, joined: S.peers, left: [], updated: [] })); return () => L.peers.delete(fn); },
    connected() { return S.connected; },
    onConnection(fn) { L.conn.add(fn); queueMicrotask(() => fn(S.connected)); return () => L.conn.delete(fn); }
  };
  function snap() {
    const docs = S.vows.map(v => Object.freeze({ id: v.id, exists: true, data: () => v.data, metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }
  const db = {
    resetBoard() { return send({ t: 'resetboard' }); },
    round() { return S.round; },
    collection() {
      const ref = {
        limit() { return ref; },
        orderBy() { return ref; },
        get() { return Promise.resolve(snap()); },
        onSnapshot(next) { const fn = () => next(snap()); L.vows.add(fn); queueMicrotask(fn); return () => L.vows.delete(fn); },
        doc(docId) {
          return {
            id: docId,
            set(body) {
              if (docId !== id) return Promise.reject({ code: 'invalid_argument', message: 'Only your own vow can be written.' });
              return send({ t: 'vow', data: body }) ? Promise.resolve() : Promise.reject({ code: 'unavailable', message: 'Offline' });
            }
          };
        }
      };
      return ref;
    }
  };
  const user = {
    isOwner: async () => S.isHost,
    canEdit: async () => S.isHost,
    can: async () => true,
    id: async () => id,
    name: async () => name,
    me: async () => ({ id, name, avatarUrl: avatar(id, name), color: color(id), email: null, isOwner: S.isHost, canEdit: S.isHost }),
    profiles: async ids => {
      const out = {};
      [].concat(ids).forEach(k => { const n = S.names[k] || ''; out[k] = { id: k, name: n, avatarUrl: avatar(k, n), color: color(k), email: null, isMe: k === id, guest: false }; });
      return out;
    },
    search: async () => []
  };
  const spaces = { room, db, user };
  window.claude = Object.freeze({ use: n => ready.then(() => spaces[n] || null) });

  /* ---------- first-visit name card ---------- */
  function askName() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:rgba(10,6,20,.78);backdrop-filter:blur(4px)';
    wrap.innerHTML =
      '<form style="width:100%;max-width:380px;display:grid;gap:12px;background:#1d1432;border:1px solid rgba(244,234,215,.14);border-radius:12px;padding:22px;color:#f4ead7;font-family:Hind,system-ui,sans-serif">' +
      '<div style="font-family:\'Yatra One\',Georgia,serif;font-size:28px;color:#f4a524;line-height:1.1">Welcome to the Ramlila ground</div>' +
      '<label for="rdName" style="color:#b3a8c4;font-size:15px">What should the team call you?</label>' +
      '<input id="rdName" maxlength="32" autocomplete="name" required placeholder="Your name" style="font:500 17px Hind,system-ui,sans-serif;color:#f4ead7;background:#130d22;border:1px solid rgba(244,234,215,.2);border-radius:8px;padding:11px 12px">' +
      '<button style="font:600 16px Hind,system-ui,sans-serif;background:#e8562a;color:#f4ead7;border:0;border-radius:8px;padding:12px;cursor:pointer">Join</button>' +
      '</form>';
    document.body.appendChild(wrap);
    const input = wrap.querySelector('input');
    setTimeout(() => input.focus(), 50);
    wrap.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      const v = input.value.trim().slice(0, 32); if (!v) return;
      name = v; ls.set('rd.name', v); S.names[id] = v; send({ t: 'name', name: v }); wrap.remove();
    });
  }
  if (!name) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', askName); else askName();
  }
})();
