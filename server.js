const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('./public/engine.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon' };

// ---------- Fichiers du site ----------
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- Parties ----------
const rooms = new Map();
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ';
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join(''); } while (rooms.has(c));
  return c;
}
const newToken = () => crypto.randomBytes(12).toString('hex');
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function broadcast(room) {
  room.seats.forEach((seat, i) => {
    if (!seat || !seat.ws) return;
    const opp = room.seats[1 - i];
    send(seat.ws, {
      t: 'room', code: room.code, seat: i, token: seat.token, S: room.state,
      oppJoined: !!opp, oppConnected: !!(opp && opp.ws), rematch: [...room.rematch]
    });
  });
}

function detach(ws) {
  const room = ws.room;
  if (!room) return;
  const seat = room.seats[ws.seat];
  if (seat && seat.ws === ws) seat.ws = null;
  ws.room = null;
  room.touched = Date.now();
  broadcast(room);
}

function attach(ws, room, i) {
  const seat = room.seats[i];
  if (seat.ws && seat.ws !== ws) { seat.ws.room = null; seat.ws.close(); }
  seat.ws = ws;
  ws.room = room;
  ws.seat = i;
}

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (ws.room) ws.room.touched = Date.now();

    if (m.t === 'create') {
      detach(ws);
      const room = { code: newCode(), state: E.fresh(), seats: [{ token: newToken(), ws: null }, null], rematch: new Set(), touched: Date.now() };
      rooms.set(room.code, room);
      attach(ws, room, 0);
      broadcast(room);
      return;
    }

    if (m.t === 'join') {
      const code = String(m.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', msg: 'Cette partie n\'existe pas ou a expiré.' });
      detach(ws);
      const idx = m.token ? room.seats.findIndex((s) => s && s.token === m.token) : -1;
      if (idx >= 0) { attach(ws, room, idx); broadcast(room); return; }
      if (!room.seats[1]) {
        room.seats[1] = { token: newToken(), ws: null };
        attach(ws, room, 1);
        room.touched = Date.now();
        broadcast(room);
        return;
      }
      return send(ws, { t: 'error', msg: 'Cette partie est déjà complète.' });
    }

    const room = ws.room;
    if (!room) return;

    if (m.t === 'move') {
      const st = room.state, seat = ws.seat;
      if (st.winner !== null || st.turn !== seat || !room.seats[1]) return;
      const pc = st.pieces[m.from];
      if (!pc || pc.p !== seat) return;
      if (E.legal(st, m.from).indexOf(m.to) === -1) return;
      room.state = E.apply(st, m.from, m.to);
      room.rematch.clear();
      broadcast(room);
      return;
    }

    if (m.t === 'rematch') {
      if (room.state.winner === null) return;
      room.rematch.add(ws.seat);
      if (room.rematch.size === 2) {
        // Revanche : on échange les couleurs.
        room.seats = [room.seats[1], room.seats[0]];
        room.seats.forEach((s, i) => { if (s && s.ws) s.ws.seat = i; });
        room.state = E.fresh();
        room.rematch.clear();
      }
      broadcast(room);
      return;
    }

    if (m.t === 'leave') detach(ws);
  });

  ws.on('close', () => detach(ws));
});

// Connexions mortes
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Parties abandonnées depuis 30 min
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const someone = room.seats.some((s) => s && s.ws);
    if (!someone && now - room.touched > 30 * 60 * 1000) rooms.delete(code);
  }
}, 60000);

server.listen(PORT, () => console.log('Ruines en écoute sur le port ' + PORT));
