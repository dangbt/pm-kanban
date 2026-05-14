const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const sharp = require('sharp');

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
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS image_data TEXT`);
}

// ── Image generation ──────────────────────────────────────────────

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapText(text, maxLen) {
  if (text.length <= maxLen) return [text, ''];
  const cut = text.lastIndexOf(' ', maxLen);
  const i = cut > 0 ? cut : maxLen;
  return [text.slice(0, i), text.slice(i + (cut > 0 ? 1 : 0), i + maxLen + 5)];
}

let fontCache = null;
async function loadFont() {
  if (fontCache) return fontCache;
  try {
    const res = await fetch('https://fonts.bunny.net/inter/files/inter-latin-ext-700-normal.woff2');
    fontCache = await res.arrayBuffer();
  } catch { fontCache = null; }
  return fontCache;
}

async function generateCardImage(ticket) {
  const p = ticket.product || {};
  const W = 1080, H = 1080, IMG_H = 630, INFO_H = 450;

  const nameRaw = (p.name || ticket.title || 'Sản phẩm Shopee').substring(0, 80);
  const [line1, line2] = wrapText(nameRaw, 38);
  const salePrice = p.sale_price ? Number(p.sale_price).toLocaleString('vi-VN') + 'đ' : '';
  const origPrice = (p.original_price && Number(p.original_price) > 0)
    ? Number(p.original_price).toLocaleString('vi-VN') + 'đ' : '';
  const discount = p.discount_pct ? `-${p.discount_pct}%` : '';
  const imageUrl = p.image_url;

  const composites = [];

  // ── 1. Product image ──
  if (imageUrl) {
    try {
      const buf = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        .then(r => r.arrayBuffer());
      const img = await sharp(Buffer.from(buf))
        .resize(W, IMG_H, { fit: 'cover', position: 'centre' })
        .png().toBuffer();
      composites.push({ input: img, top: 0, left: 0 });
    } catch { /* fallback to placeholder */ }
  }

  if (composites.length === 0) {
    // Placeholder gradient
    const ph = Buffer.from(`<svg width="${W}" height="${IMG_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#27272a"/>
          <stop offset="100%" stop-color="#3f3f46"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${IMG_H}" fill="url(#g)"/>
      <text x="${W/2}" y="${IMG_H/2+20}" text-anchor="middle" dominant-baseline="middle"
            font-size="140" font-family="serif" fill="#52525b">🛍</text>
    </svg>`);
    composites.push({ input: ph, top: 0, left: 0 });
  }

  // ── 2. Gradient fade on product image bottom ──
  const fade = Buffer.from(`<svg width="${W}" height="${IMG_H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
        <stop offset="55%" stop-color="#111111" stop-opacity="0"/>
        <stop offset="100%" stop-color="#111111" stop-opacity="1"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${IMG_H}" fill="url(#f)"/>
  </svg>`);
  composites.push({ input: fade, top: 0, left: 0 });

  // ── 3. Info panel background ──
  const infoBg = Buffer.from(`<svg width="${W}" height="${INFO_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${INFO_H}" fill="#1c1c1e"/>
    <rect width="${W}" height="4" fill="#f97316"/>
  </svg>`);
  composites.push({ input: infoBg, top: IMG_H, left: 0 });

  // ── 4. Text layer ──
  const priceY = line2 ? 220 : 185;
  const badgeY = priceY - 44;
  const ctaY   = INFO_H - 108;

  const textSvg = Buffer.from(`<svg width="${W}" height="${INFO_H}" xmlns="http://www.w3.org/2000/svg">
    <style>
      text { font-family: 'Noto Sans', 'Liberation Sans', 'DejaVu Sans', sans-serif; }
    </style>

    <!-- Product name -->
    <text x="48" y="72" font-size="44" font-weight="bold" fill="#ffffff">${escXml(line1)}</text>
    ${line2 ? `<text x="48" y="128" font-size="44" font-weight="bold" fill="#ffffff">${escXml(line2)}</text>` : ''}

    <!-- Sale price -->
    ${salePrice ? `<text x="48" y="${priceY}" font-size="64" font-weight="bold" fill="#10b981">${escXml(salePrice)}</text>` : ''}

    <!-- Original price -->
    ${origPrice ? `<text x="340" y="${priceY - 8}" font-size="32" fill="#71717a" text-decoration="line-through">${escXml(origPrice)}</text>` : ''}

    <!-- Discount badge -->
    ${discount ? `
      <rect x="48" y="${badgeY + (line2 ? 120 : 105)}" width="148" height="52" rx="10" fill="#ef4444"/>
      <text x="122" y="${badgeY + (line2 ? 154 : 139)}" text-anchor="middle" font-size="30" font-weight="bold" fill="#ffffff">${escXml(discount)}</text>
    ` : ''}

    <!-- CTA button -->
    <rect x="48" y="${ctaY}" width="560" height="68" rx="14" fill="#f97316"/>
    <text x="328" y="${ctaY + 44}" text-anchor="middle" font-size="30" font-weight="bold" fill="#ffffff">Mua ngay tren Shopee →</text>

    <!-- Shopee branding -->
    <text x="${W - 48}" y="${ctaY + 44}" text-anchor="end" font-size="26" fill="#52525b">#shopee #muasam</text>
  </svg>`);
  composites.push({ input: textSvg, top: IMG_H, left: 0 });

  return sharp({
    create: { width: W, height: H, channels: 4, background: { r: 17, g: 17, b: 17, alpha: 1 } }
  }).composite(composites).png({ compressionLevel: 8 }).toBuffer();
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

  // POST /api/tickets/:id/generate-image
  const genImg = url.pathname.match(/^\/api\/tickets\/(.+)\/generate-image$/);
  if (genImg && req.method === 'POST') {
    if (!authOk(req)) { json(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const id = decodeURIComponent(genImg[1]);
      const { rows } = await pool.query('SELECT * FROM tickets WHERE ticket_id = $1', [id]);
      if (!rows.length) { json(res, 404, { error: 'Not found' }); return; }
      const ticket = rows[0];
      if (ticket.product && typeof ticket.product === 'string') {
        ticket.product = JSON.parse(ticket.product);
      }
      // Allow caller to pass extra product fields (e.g. image_url)
      const body = await readBody(req);
      if (body.image_url && ticket.product) ticket.product.image_url = body.image_url;

      const imgBuf = await generateCardImage(ticket);
      const b64 = imgBuf.toString('base64');
      await pool.query(
        `UPDATE tickets SET image_data = $2, updated_at = NOW() WHERE ticket_id = $1`,
        [id, b64]
      );
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/tickets/:id/image — serve PNG
  const getImg = url.pathname.match(/^\/api\/tickets\/(.+)\/image$/);
  if (getImg && req.method === 'GET') {
    try {
      const id = decodeURIComponent(getImg[1]);
      const { rows } = await pool.query('SELECT image_data FROM tickets WHERE ticket_id = $1', [id]);
      if (!rows.length || !rows[0].image_data) { res.writeHead(404); res.end(); return; }
      const buf = Buffer.from(rows[0].image_data, 'base64');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=3600' });
      res.end(buf);
    } catch (e) {
      res.writeHead(500); res.end();
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
