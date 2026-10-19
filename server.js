// 영화 스터디 시간 맞추기 서버. 외부 패키지 없이 Node 내장 모듈만 사용해요.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_WEEKS = 26;
const MAX_PEOPLE = 300;
const SLOT_RE = /^\d{4}-\d{2}-\d{2}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function mondayOfThisWeekKST() {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  k.setUTCDate(k.getUTCDate() - ((k.getUTCDay() + 6) % 7));
  return k.toISOString().slice(0, 10);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
let db = {
  config: {
    title: process.env.TITLE || '영화 스터디',
    start: process.env.START_DATE || mondayOfThisWeekKST(),
    days: 14,
  },
  responses: {},
};
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  db = { config: Object.assign(db.config, saved.config), responses: saved.responses || {} };
} catch (e) { /* 첫 실행이면 기본값으로 시작 */ }

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const given = String(req.headers['x-admin-key'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 200 * 1024) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, INDEX.replace(/\{\{TITLE\}\}/g, esc(db.config.title)), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, {
        config: db.config,
        adminEnabled: !!ADMIN_KEY,
        responses: Object.values(db.responses).map((r) => ({ name: r.name, slots: r.slots })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/admin') {
      return send(res, isAdmin(req) ? 200 : 401, { ok: isAdmin(req) });
    }

    if (req.method === 'PUT' && url.pathname === '/api/responses') {
      const b = await readBody(req);
      const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
      if (!name || name.length > 20 || /[\u0000-\u001f]/.test(name)) return send(res, 400, { error: '이름은 1~20자로 입력해 주세요.' });
      if (!Array.isArray(b.slots) || b.slots.length > 3000) return send(res, 400, { error: '시간 목록이 올바르지 않아요.' });
      const slots = Array.from(new Set(b.slots.filter((s) => typeof s === 'string' && SLOT_RE.test(s)))).sort();
      if (!db.responses[name] && Object.keys(db.responses).length >= MAX_PEOPLE) return send(res, 400, { error: '응답 인원이 가득 찼어요.' });
      db.responses[name] = { name, slots, updatedAt: Date.now() };
      save();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/responses') {
      if (!isAdmin(req)) return send(res, 401, { error: '관리자만 할 수 있어요.' });
      const name = url.searchParams.get('name') || '';
      delete db.responses[name];
      save();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/weeks') {
      const b = await readBody(req);
      const delta = b.delta === 1 ? 1 : b.delta === -1 ? -1 : 0;
      if (!delta) return send(res, 400, { error: 'delta는 1 또는 -1이에요.' });
      if (delta < 0 && !isAdmin(req)) return send(res, 401, { error: '주 삭제는 관리자만 할 수 있어요.' });
      const weeks = Math.ceil(db.config.days / 7) + delta;
      if (weeks < 1 || weeks > MAX_WEEKS) return send(res, 400, { error: '더 바꿀 수 없어요.' });
      db.config.days = weeks * 7;
      save();
      return send(res, 200, { config: db.config });
    }

    if (req.method === 'PUT' && url.pathname === '/api/config') {
      if (!isAdmin(req)) return send(res, 401, { error: '관리자만 할 수 있어요.' });
      const b = await readBody(req);
      const title = typeof b.title === 'string' ? b.title.trim() : '';
      if (title) { if (title.length > 30) return send(res, 400, { error: '모임 이름은 30자까지예요.' }); db.config.title = title; }
      if (b.start !== undefined) { if (!validDate(b.start)) return send(res, 400, { error: '날짜 형식이 올바르지 않아요.' }); db.config.start = b.start; }
      save();
      return send(res, 200, { config: db.config });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
  }
});

server.listen(PORT, () => console.log('listening on ' + PORT + ' / data: ' + DATA_FILE + (ADMIN_KEY ? '' : ' / ADMIN_KEY not set')));
