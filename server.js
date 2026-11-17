// ナンバーコール — 通話しながら遊ぶ数字あてゲームのサーバー
// 依存パッケージなし（Node.js 18 以上）。起動: node server.js  → http://localhost:3000
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 8;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000; // 誰も接続していないルームは6時間で削除

// ---- 選べる数字 ----
// 単位（なし・万・億・兆）ごとに: 0〜100 は全部、100〜1000 は頭2桁、1000〜9000 は頭1桁
const BASE = [];
for (let i = 0; i <= 100; i++) BASE.push(i);
for (let i = 110; i <= 990; i += 10) BASE.push(i);
for (let i = 1000; i <= 9000; i += 1000) BASE.push(i);
const UNITS = [1, 1e4, 1e8, 1e12];
const VALID = new Set(UNITS.flatMap(u => BASE.map(b => b * u)));
const MIN_ALL = 0, MAX_ALL = 9000 * 1e12;

// ---- ルーム ----
/** code -> { state, tokens: Map<token, playerId>, clients: Set<{res, id}>, touched } */
const rooms = new Map();

function rid(n, abc = 'abcdefghijkmnpqrstuvwxyz23456789') {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += abc[bytes[i] % abc.length];
  return s;
}
function newCode() {
  for (;;) { const c = rid(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); if (!rooms.has(c)) return c; }
}
function freshState() {
  return { status: 'lobby', min: MIN_ALL, max: MAX_ALL, showAll: true, players: {}, order: [], secrets: {},
    firstIdx: 0, turnIdx: 0, log: [], winner: null, round: 1 };
}

const joined = s => Object.keys(s.players).sort((a, b) => s.players[a].t - s.players[b].t);
const nextOf = (s, id) => s.order[(s.order.indexOf(id) + 1) % s.order.length];
const setterOf = (s, id) => s.order[(s.order.indexOf(id) - 1 + s.order.length) % s.order.length];
const turnId = s => s.order[s.turnIdx % s.order.length];

// 見る人ごとに、見てはいけない数字を伏せた状態を作る
function viewFor(room, me) {
  const s = room.state;
  const inGame = me && s.order.includes(me);
  const secrets = {}, decided = {};
  for (const id of s.order) {
    const v = s.secrets[id];
    decided[id] = v != null;
    const visible = s.status === 'over' || (inGame && id !== me && (s.showAll || setterOf(s, id) === me));
    if (visible && v != null) secrets[id] = v;
  }
  return { ...s, secrets, decided, me: me || null };
}

function send(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
function broadcast(room) {
  room.touched = Date.now();
  for (const c of room.clients) send(c.res, viewFor(room, c.id));
}

class GameError extends Error {}
const fail = msg => { throw new GameError(msg); };
const rangeOk = (s, v) => VALID.has(v) && v >= s.min && v <= s.max;

// ---- 操作 ----
const actions = {
  join(room, _id, body) {
    const s = room.state;
    if (s.status !== 'lobby') fail('ゲーム中は参加できません。ロビーに戻るまで待ってください。');
    if (joined(s).length >= MAX_PLAYERS) fail(`満員です（${MAX_PLAYERS}人まで）。`);
    const name = String(body.name || '').trim().slice(0, 16);
    if (!name) fail('名前を入力してください。');
    const id = rid(8), token = rid(24);
    s.players[id] = { name, t: Date.now() };
    room.tokens.set(token, id);
    return { id, token };
  },
  leave(room, id) {
    const s = room.state;
    if (s.status !== 'lobby') return {};
    delete s.players[id];
    for (const [t, pid] of room.tokens) if (pid === id) room.tokens.delete(t);
    return {};
  },
  kick(room, _id, body) {
    const s = room.state;
    if (s.status !== 'lobby') fail('ロビーでのみ外せます。');
    const target = String(body.target || '');
    delete s.players[target];
    for (const [t, pid] of room.tokens) if (pid === target) room.tokens.delete(t);
    return {};
  },
  settings(room, _id, body) {
    const s = room.state;
    if (s.status !== 'lobby') fail('ロビーでのみ変更できます。');
    if (body.min !== undefined || body.max !== undefined) {
      const mn = Number(body.min ?? s.min), mx = Number(body.max ?? s.max);
      if (!VALID.has(mn) || !VALID.has(mx) || !(mn < mx)) fail('範囲は「小さい数 〜 大きい数」で選んでください。');
      s.min = mn; s.max = mx;
    }
    if (typeof body.showAll === 'boolean') s.showAll = body.showAll;
    return {};
  },
  start(room) {
    const s = room.state;
    if (s.status !== 'lobby') fail('すでに始まっています。');
    const o = joined(s);
    if (o.length < 2) fail('2人以上で始められます。');
    s.order = o; s.secrets = {}; s.log = []; s.winner = null;
    s.firstIdx = s.firstIdx % o.length; s.turnIdx = s.firstIdx;
    s.status = 'setup';
    return {};
  },
  secret(room, id, body) {
    const s = room.state;
    if (s.status !== 'setup') fail('今は数字を決める時間ではありません。');
    const target = nextOf(s, id);
    if (body.value === null) { s.secrets[target] = null; return {}; }
    const v = Number(body.value);
    if (!rangeOk(s, v)) fail('範囲の中から選んでください。');
    s.secrets[target] = v;
    if (s.order.every(p => s.secrets[p] != null)) { s.status = 'play'; s.turnIdx = s.firstIdx; }
    return {};
  },
  guess(room, id, body) {
    const s = room.state;
    if (s.status !== 'play' || turnId(s) !== id) fail('あなたのターンではありません。');
    const v = Number(body.value);
    if (!rangeOk(s, v)) fail('範囲の中から選んでください。');
    const ok = v === s.secrets[id];
    s.log.push({ p: id, g: v, ok });
    if (ok) { s.status = 'over'; s.winner = id; }
    else s.turnIdx = (s.turnIdx + 1) % s.order.length;
    return { ok };
  },
  pass(room, id) {
    const s = room.state;
    if (s.status !== 'play' || turnId(s) !== id) fail('あなたのターンではありません。');
    s.log.push({ p: id, pass: true });
    s.turnIdx = (s.turnIdx + 1) % s.order.length;
    return {};
  },
  again(room) {
    const s = room.state;
    if (s.status !== 'over') fail('まだ決着していません。');
    s.firstIdx = (s.firstIdx + 1) % s.order.length;
    s.turnIdx = s.firstIdx; s.secrets = {}; s.log = []; s.winner = null; s.round += 1;
    s.status = 'setup';
    return {};
  },
  lobby(room) {
    const s = room.state;
    if (s.status === 'over') { s.firstIdx = (s.firstIdx + 1) % Math.max(1, s.order.length); s.round += 1; }
    s.status = 'lobby'; s.log = []; s.winner = null; s.secrets = {};
    return {};
  }
};

// ---- HTTP ----
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 10_000) { reject(new GameError('データが大きすぎます。')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new GameError('データの形式が正しくありません。')); } });
    req.on('error', reject);
  });
}

const INDEX = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    if (parts[0] !== 'api' || parts[1] !== 'rooms') return json(res, 404, { error: 'ページが見つかりません。' });

    // POST /api/rooms → 新しいルーム
    if (parts.length === 2 && req.method === 'POST') {
      const code = newCode();
      rooms.set(code, { state: freshState(), tokens: new Map(), clients: new Set(), touched: Date.now() });
      return json(res, 200, { code });
    }

    const code = String(parts[2] || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return json(res, 404, { error: `ルーム ${code} は見つかりませんでした。コードを確認してください。` });

    // GET /api/rooms/:code → 存在確認
    if (parts.length === 3 && req.method === 'GET') return json(res, 200, { code });

    // GET /api/rooms/:code/events?token= → リアルタイム更新（Server-Sent Events）
    if (parts[3] === 'events' && req.method === 'GET') {
      const id = room.tokens.get(url.searchParams.get('token') || '') || null;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const client = { res, id };
      room.clients.add(client);
      send(res, viewFor(room, id));
      req.on('close', () => { room.clients.delete(client); room.touched = Date.now(); });
      return;
    }

    // POST /api/rooms/:code/:action
    if (parts.length === 4 && req.method === 'POST' && Object.hasOwn(actions, parts[3])) {
      const body = await readBody(req);
      const action = parts[3];
      let id = null;
      if (action !== 'join') {
        id = room.tokens.get(String(body.token || ''));
        if (!id || !room.state.players[id]) return json(res, 403, { error: 'このルームの参加者ではありません。もう一度参加してください。', gone: true });
      }
      const result = actions[action](room, id, body);
      // 抜けた人の接続は観戦あつかいにする（参加した人はクライアント側で接続し直す）
      if (action === 'leave' || action === 'kick') for (const c of room.clients) if (c.id && !room.state.players[c.id]) c.id = null;
      broadcast(room);
      return json(res, 200, result);
    }
    return json(res, 404, { error: 'ページが見つかりません。' });
  } catch (e) {
    if (e instanceof GameError) return json(res, 400, { error: e.message });
    console.error(e);
    return json(res, 500, { error: 'サーバーでエラーが起きました。' });
  }
});

// 接続を保つための定期送信と、使われなくなったルームの掃除
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const c of room.clients) c.res.write(': ping\n\n');
    if (room.clients.size === 0 && now - room.touched > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 25_000).unref();

server.listen(PORT, () => console.log(`ナンバーコール: http://localhost:${PORT}`));
