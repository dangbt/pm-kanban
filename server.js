const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3210;
const API_KEY = process.env.API_KEY || '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id       TEXT PRIMARY KEY,
      title           TEXT,
      status          TEXT DEFAULT 'open',
      priority        TEXT DEFAULT 'high',
      assigned_to     TEXT,
      created_at      TIMESTAMPTZ,
      completed_at    TIMESTAMPTZ,
      output_location TEXT,
      content         TEXT,
      product         JSONB,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS content TEXT`);
}

function authOk(req) {
  if (!API_KEY) return true;
  return req.headers['x-api-key'] === API_KEY;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /api/tickets
  if (url.pathname === '/api/tickets' && req.method === 'GET') {
    try {
      const { rows } = await pool.query('SELECT * FROM tickets ORDER BY created_at DESC');
      json(res, 200, rows);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/tickets — insert only, skip if ticket_id already exists
  if (url.pathname === '/api/tickets' && req.method === 'POST') {
    if (!authOk(req)) { json(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const t = await readBody(req);
      const result = await pool.query(`
        INSERT INTO tickets
          (ticket_id, title, status, priority, assigned_to, created_at, completed_at, output_location, content, product)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (ticket_id) DO NOTHING
      `, [
        t.ticket_id, t.title, t.status, t.priority,
        t.assigned_to, t.created_at, t.completed_at,
        t.output_location, t.content || null, JSON.stringify(t.product || {}),
      ]);
      const inserted = result.rowCount > 0;
      json(res, inserted ? 201 : 200, { ok: true, inserted });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return;
  }

  // PATCH /api/tickets/:id
  const patch = url.pathname.match(/^\/api\/tickets\/(.+)$/);
  if (patch && req.method === 'PATCH') {
    if (!authOk(req)) { json(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const id = decodeURIComponent(patch[1]);
      const u = await readBody(req);
      await pool.query(`
        UPDATE tickets SET
          status          = COALESCE($2, status),
          completed_at    = COALESCE($3, completed_at),
          output_location = COALESCE($4, output_location),
          content         = COALESCE($5, content),
          updated_at      = NOW()
        WHERE ticket_id = $1
      `, [id, u.status, u.completed_at, u.output_location, u.content || null]);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return;
  }

  // Serve index.html
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

initDb()
  .then(() => server.listen(PORT, () => console.log(`PM Kanban → http://localhost:${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
