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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id             SERIAL PRIMARY KEY,
      affiliate_link TEXT UNIQUE,
      shopid         TEXT,
      itemid         TEXT,
      name           TEXT,
      sale_price     BIGINT DEFAULT 0,
      original_price BIGINT DEFAULT 0,
      discount_pct   INT DEFAULT 0,
      category       TEXT,
      image_url      TEXT,
      key_features   JSONB DEFAULT '[]',
      shop_info      JSONB DEFAULT '{}',
      crawled_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Shopee crawler ────────────────────────────────────────────────

async function crawlShopee(affiliateLink) {
  let browser;
  try {
    const { chromium } = require('playwright');
    const { existsSync } = require('fs');
    const systemChromium = [
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
    ].find(p => existsSync(p));

    browser = await chromium.launch({
      headless: true,
      executablePath: systemChromium || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'],
    });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/20G75 Safari/604.1',
      locale: 'vi-VN',
      extraHTTPHeaders: { 'Accept-Language': 'vi-VN,vi;q=0.9' },
    });
    const page = await ctx.newPage();

    // Follow redirect to get final URL
    const resp = await page.goto(affiliateLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const finalUrl = page.url();

    // Extract shopid + itemid from URL patterns:
    // /product/{shopid}/{itemid} or /{slug}-i.{shopid}.{itemid}
    let shopid, itemid;
    const m1 = finalUrl.match(/shopee\.vn\/product\/(\d+)\/(\d+)/);
    const m2 = finalUrl.match(/-i\.(\d+)\.(\d+)/);
    if (m1) { shopid = m1[1]; itemid = m1[2]; }
    else if (m2) { shopid = m2[1]; itemid = m2[2]; }

    // Try Shopee internal API with cookies from page visit
    let apiData = null;
    if (shopid && itemid) {
      try {
        const apiResp = await page.evaluate(async ({ sid, iid }) => {
          const r = await fetch(`/api/v4/item/get?itemid=${iid}&shopid=${sid}`, {
            headers: { 'x-api-source': 'pc', 'af-ac-enc-dat': 'null' },
          });
          return r.json();
        }, { sid: shopid, iid: itemid });
        if (apiResp?.data) apiData = apiResp.data;
      } catch {}
    }

    let name, salePrice, origPrice, discountPct, imageUrl, keyFeatures, category, shopInfo;

    if (apiData) {
      name = apiData.name;
      salePrice = Math.round((apiData.price_min || apiData.price || 0) / 100000);
      origPrice = Math.round((apiData.price_before_discount || apiData.raw_discount || 0) / 100000) || salePrice;
      discountPct = apiData.discount ? parseInt(apiData.discount) : (origPrice > salePrice ? Math.round((1 - salePrice / origPrice) * 100) : 0);
      imageUrl = apiData.image ? `https://cf.shopee.vn/file/${apiData.image}` : null;
      keyFeatures = (apiData.description || '').split('\n').filter(l => l.trim().length > 10).slice(0, 6);
      category = apiData.categories?.map(c => c.display_name).join(' / ') || '';
      shopInfo = { name: apiData.shop_name, rating: apiData.item_rating?.rating_star };
    } else {
      // Fallback: wait for DOM render and extract
      await page.waitForTimeout(5000);
      const extracted = await page.evaluate(() => {
        const metaTitle = document.querySelector('meta[property="og:title"]')?.content || document.title || '';
        const metaImg = document.querySelector('meta[property="og:image"]')?.content || '';
        const priceEls = [...document.querySelectorAll('[class*="pqTWkA"],[class*="price"],[class*="Price"]')]
          .map(el => el.textContent.replace(/[^\d]/g, '')).filter(p => p.length >= 4 && p.length <= 9);
        return { title: metaTitle, img: metaImg, prices: priceEls };
      });
      name = extracted.title.replace(/\s*[-|].*shopee.*/i, '').trim() || 'Sản phẩm Shopee';
      imageUrl = extracted.img || null;
      const prices = extracted.prices.map(Number).filter(p => p > 1000).sort((a, b) => a - b);
      salePrice = prices[0] || 0;
      origPrice = prices[prices.length - 1] || salePrice;
      discountPct = origPrice > salePrice ? Math.round((1 - salePrice / origPrice) * 100) : 0;
      keyFeatures = [];
      category = '';
      shopInfo = {};
    }

    return { shopid, itemid, name, sale_price: salePrice, original_price: origPrice, discount_pct: discountPct, image_url: imageUrl, key_features: keyFeatures, category, shop_info: shopInfo };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
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

  if (imageUrl) {
    try {
      const buf = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        .then(r => r.arrayBuffer());
      const img = await sharp(Buffer.from(buf))
        .resize(W, IMG_H, { fit: 'cover', position: 'centre' })
        .png().toBuffer();
      composites.push({ input: img, top: 0, left: 0 });
    } catch {}
  }

  if (composites.length === 0) {
    const ph = Buffer.from(`<svg width="${W}" height="${IMG_H}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#27272a"/><stop offset="100%" stop-color="#3f3f46"/>
      </linearGradient></defs>
      <rect width="${W}" height="${IMG_H}" fill="url(#g)"/>
      <text x="${W/2}" y="${IMG_H/2+20}" text-anchor="middle" dominant-baseline="middle"
            font-size="140" font-family="serif" fill="#52525b">🛍</text>
    </svg>`);
    composites.push({ input: ph, top: 0, left: 0 });
  }

  const fade = Buffer.from(`<svg width="${W}" height="${IMG_H}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
      <stop offset="55%" stop-color="#111111" stop-opacity="0"/>
      <stop offset="100%" stop-color="#111111" stop-opacity="1"/>
    </linearGradient></defs>
    <rect width="${W}" height="${IMG_H}" fill="url(#f)"/>
  </svg>`);
  composites.push({ input: fade, top: 0, left: 0 });

  const infoBg = Buffer.from(`<svg width="${W}" height="${INFO_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${INFO_H}" fill="#1c1c1e"/>
    <rect width="${W}" height="4" fill="#f97316"/>
  </svg>`);
  composites.push({ input: infoBg, top: IMG_H, left: 0 });

  const priceY = line2 ? 220 : 185;
  const badgeY = priceY - 44;
  const ctaY   = INFO_H - 108;

  const textSvg = Buffer.from(`<svg width="${W}" height="${INFO_H}" xmlns="http://www.w3.org/2000/svg">
    <style>text { font-family: 'Noto Sans', 'Liberation Sans', 'DejaVu Sans', sans-serif; }</style>
    <text x="48" y="72" font-size="44" font-weight="bold" fill="#ffffff">${escXml(line1)}</text>
    ${line2 ? `<text x="48" y="128" font-size="44" font-weight="bold" fill="#ffffff">${escXml(line2)}</text>` : ''}
    ${salePrice ? `<text x="48" y="${priceY}" font-size="64" font-weight="bold" fill="#10b981">${escXml(salePrice)}</text>` : ''}
    ${origPrice ? `<text x="340" y="${priceY - 8}" font-size="32" fill="#71717a" text-decoration="line-through">${escXml(origPrice)}</text>` : ''}
    ${discount ? `
      <rect x="48" y="${badgeY + (line2 ? 120 : 105)}" width="148" height="52" rx="10" fill="#ef4444"/>
      <text x="122" y="${badgeY + (line2 ? 154 : 139)}" text-anchor="middle" font-size="30" font-weight="bold" fill="#ffffff">${escXml(discount)}</text>
    ` : ''}
    <rect x="48" y="${ctaY}" width="560" height="68" rx="14" fill="#f97316"/>
    <text x="328" y="${ctaY + 44}" text-anchor="middle" font-size="30" font-weight="bold" fill="#ffffff">Mua ngay tren Shopee →</text>
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /api/tickets
  if (url.pathname === '/api/tickets' && req.method === 'GET') {
    try {
      const { rows } = await pool.query('SELECT * FROM tickets ORDER BY created_at DESC');
      json(res, 200, rows);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // POST /api/tickets — auto-generate ticket_id if not provided
  if (url.pathname === '/api/tickets' && req.method === 'POST') {
    if (!authOk(req)) { json(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const t = await readBody(req);
      if (!t.ticket_id) {
        const { rows: existing } = await pool.query(`SELECT ticket_id FROM tickets WHERE ticket_id ~ '^PM-[0-9]+$'`);
        const nums = existing.map(r => parseInt(r.ticket_id.replace('PM-', ''), 10)).filter(n => !isNaN(n));
        t.ticket_id = `PM-${(nums.length > 0 ? Math.max(...nums) : 0) + 1}`;
      }
      const result = await pool.query(`
        INSERT INTO tickets (ticket_id, title, status, priority, assigned_to, created_at, completed_at, output_location, content, product)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (ticket_id) DO NOTHING
      `, [t.ticket_id, t.title, t.status, t.priority, t.assigned_to, t.created_at, t.completed_at, t.output_location, t.content || null, JSON.stringify(t.product || {})]);
      json(res, result.rowCount > 0 ? 201 : 200, { ok: true, inserted: result.rowCount > 0, ticket_id: t.ticket_id });
    } catch (e) { json(res, 400, { error: e.message }); }
    return;
  }

  // PATCH /api/tickets/:id
  const patchMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    if (!authOk(req)) { json(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const id = decodeURIComponent(patchMatch[1]);
      const u = await readBody(req);
      await pool.query(`
        UPDATE tickets SET status = COALESCE($2, status), completed_at = COALESCE($3, completed_at),
          output_location = COALESCE($4, output_location), content = COALESCE($5, content), updated_at = NOW()
        WHERE ticket_id = $1
      `, [id, u.status, u.completed_at, u.output_location, u.content || null]);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: e.message }); }
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
      if (ticket.product && typeof ticket.product === 'string') ticket.product = JSON.parse(ticket.product);
      const body = await readBody(req);
      if (body.image_url && ticket.product) ticket.product.image_url = body.image_url;
      const imgBuf = await generateCardImage(ticket);
      await pool.query(`UPDATE tickets SET image_data = $2, updated_at = NOW() WHERE ticket_id = $1`, [id, imgBuf.toString('base64')]);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // GET /api/tickets/:id/image
  const getImg = url.pathname.match(/^\/api\/tickets\/(.+)\/image$/);
  if (getImg && req.method === 'GET') {
    try {
      const id = decodeURIComponent(getImg[1]);
      const { rows } = await pool.query('SELECT image_data FROM tickets WHERE ticket_id = $1', [id]);
      if (!rows.length || !rows[0].image_data) { res.writeHead(404); res.end(); return; }
      const buf = Buffer.from(rows[0].image_data, 'base64');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=3600' });
      res.end(buf);
    } catch (e) { res.writeHead(500); res.end(); }
    return;
  }

  // ── Products ──────────────────────────────────────────────────────

  // GET /api/products
  if (url.pathname === '/api/products' && req.method === 'GET') {
    try {
      const link = url.searchParams.get('link');
      if (link) {
        const { rows } = await pool.query('SELECT * FROM products WHERE affiliate_link = $1', [link]);
        json(res, 200, rows[0] || null);
      } else {
        const { rows } = await pool.query('SELECT * FROM products ORDER BY crawled_at DESC');
        json(res, 200, rows);
      }
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // POST /api/crawl — crawl Shopee product and save to DB
  if (url.pathname === '/api/crawl' && req.method === 'POST') {
    if (!authOk(req)) { json(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const { link } = await readBody(req);
      if (!link) { json(res, 400, { error: 'link required' }); return; }

      const data = await crawlShopee(link);

      const { rows } = await pool.query(`
        INSERT INTO products (affiliate_link, shopid, itemid, name, sale_price, original_price, discount_pct, category, image_url, key_features, shop_info)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (affiliate_link) DO UPDATE SET
          name = EXCLUDED.name, sale_price = EXCLUDED.sale_price, original_price = EXCLUDED.original_price,
          discount_pct = EXCLUDED.discount_pct, category = EXCLUDED.category, image_url = EXCLUDED.image_url,
          key_features = EXCLUDED.key_features, shop_info = EXCLUDED.shop_info, crawled_at = NOW()
        RETURNING *
      `, [link, data.shopid, data.itemid, data.name, data.sale_price, data.original_price, data.discount_pct, data.category, data.image_url, JSON.stringify(data.key_features || []), JSON.stringify(data.shop_info || {})]);

      json(res, 200, { ok: true, product: rows[0] });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // DELETE /api/products/:id
  const delProd = url.pathname.match(/^\/api\/products\/(\d+)$/);
  if (delProd && req.method === 'DELETE') {
    if (!authOk(req)) { json(res, 401, { error: 'Unauthorized' }); return; }
    try {
      await pool.query('DELETE FROM products WHERE id = $1', [delProd[1]]);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: e.message }); }
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
