#!/usr/bin/env node
/**
 * crawl-local.js — chạy local để crawl Shopee bằng Playwright
 * Usage: node crawl-local.js "https://s.shopee.vn/xxx"
 *
 * Env vars (optional):
 *   PM_URL   — Render server URL (default: https://pm-kanban.onrender.com)
 *   API_KEY  — server API key   (default: dangbadao)
 */

const { chromium } = require('playwright');
const https = require('https');
const http = require('http');

const RENDER_URL = process.env.PM_URL || 'https://pm-kanban.onrender.com';
const API_KEY    = process.env.API_KEY || 'dangbadao';

async function crawlShopee(affiliateLink) {
  console.log('🔍 Mở Shopee...');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/20G75 Safari/604.1',
      locale: 'vi-VN',
      extraHTTPHeaders: { 'Accept-Language': 'vi-VN,vi;q=0.9' },
    });
    const page = await ctx.newPage();

    await page.goto(affiliateLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const finalUrl = page.url();
    console.log('🔗 URL:', finalUrl);

    let shopid, itemid;
    const m1 = finalUrl.match(/shopee\.vn\/product\/(\d+)\/(\d+)/);
    const m2 = finalUrl.match(/-i\.(\d+)\.(\d+)/);
    if (m1) { shopid = m1[1]; itemid = m1[2]; }
    else if (m2) { shopid = m2[1]; itemid = m2[2]; }

    // Try Shopee internal API using the page's own session cookies
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
      console.log('✅ Lấy được data từ Shopee API');
      name        = apiData.name;
      salePrice   = Math.round((apiData.price_min || apiData.price || 0) / 100000);
      origPrice   = Math.round((apiData.price_before_discount || 0) / 100000) || salePrice;
      discountPct = apiData.discount
        ? parseInt(apiData.discount)
        : (origPrice > salePrice ? Math.round((1 - salePrice / origPrice) * 100) : 0);
      imageUrl    = apiData.image ? `https://cf.shopee.vn/file/${apiData.image}` : null;
      keyFeatures = (apiData.description || '').split('\n').filter(l => l.trim().length > 10).slice(0, 6);
      category    = apiData.categories?.map(c => c.display_name).join(' / ') || '';
      shopInfo    = { name: apiData.shop_name, rating: apiData.item_rating?.rating_star };
    } else {
      console.log('⚠️  API không trả data, fallback DOM...');
      await page.waitForTimeout(5000);
      const extracted = await page.evaluate(() => {
        const metaTitle = document.querySelector('meta[property="og:title"]')?.content || document.title || '';
        const metaImg   = document.querySelector('meta[property="og:image"]')?.content || '';
        const priceEls  = [...document.querySelectorAll('[class*="pqTWkA"],[class*="price"],[class*="Price"]')]
          .map(el => el.textContent.replace(/[^\d]/g, '')).filter(p => p.length >= 4 && p.length <= 9);
        return { title: metaTitle, img: metaImg, prices: priceEls };
      });
      name        = extracted.title.replace(/\s*[-|].*shopee.*/i, '').trim() || 'Sản phẩm Shopee';
      imageUrl    = extracted.img || null;
      const prices = extracted.prices.map(Number).filter(p => p > 1000).sort((a, b) => a - b);
      salePrice   = prices[0] || 0;
      origPrice   = prices[prices.length - 1] || salePrice;
      discountPct = origPrice > salePrice ? Math.round((1 - salePrice / origPrice) * 100) : 0;
      keyFeatures = [];
      category    = '';
      shopInfo    = {};
    }

    return { shopid, itemid, name, sale_price: salePrice, original_price: origPrice, discount_pct: discountPct, image_url: imageUrl, key_features: keyFeatures, category, shop_info: shopInfo };
  } finally {
    await browser.close();
  }
}

function post(url, data, apiKey) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(data);
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-API-Key': apiKey,
      },
    };
    const req = lib.request(options, res => {
      let buf = '';
      res.on('data', c => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const link = process.argv[2];
  if (!link) {
    console.error('Usage: node crawl-local.js "https://s.shopee.vn/..."');
    process.exit(1);
  }

  const data = await crawlShopee(link);

  console.log('\n📦 Kết quả:');
  console.log('  Tên   :', data.name);
  console.log('  Giá   :', data.sale_price, 'đ  (gốc', data.original_price, 'đ,', data.discount_pct + '% off)');
  console.log('  Ảnh   :', data.image_url ? '✓' : '✗');
  console.log('  Cat   :', data.category || '—');

  console.log('\n📡 Lưu lên server...');
  const result = await post(`${RENDER_URL}/api/products/import`, { affiliate_link: link, ...data }, API_KEY);

  if (result.status === 200 || result.status === 201) {
    console.log('✅ Xong! ID:', result.body.product?.id);
  } else {
    console.error('❌ Lỗi server:', result.body);
    process.exit(1);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
