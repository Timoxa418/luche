#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'public', 'products.json');
const OVERRIDES = path.join(ROOT, 'overrides.json');
const IMG_DIR = path.join(ROOT, 'public', 'img');

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(name);

const skipImages = flag('--no-images');
const maxPhotos = Number(opt('--max-photos') || 5);
const token = process.env.WB_TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wb(url, { method = 'GET', body } = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      await sleep(1500 * attempt);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`WB ${res.status} на ${url}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`WB: лимит запросов (${url})`);
}

async function fetchCards() {
  const cards = [];
  let cursor = { limit: 100 };
  for (;;) {
    const r = await wb('https://content-api.wildberries.ru/content/v2/get/cards/list?locale=ru', {
      method: 'POST',
      body: { settings: { cursor, filter: { withPhoto: -1 } } },
    });
    const list = r.cards || [];
    cards.push(...list);
    const c = r.cursor || {};
    process.stdout.write(`\rКарточек получено: ${cards.length}`);
    if (list.length < 100 || !c.nmID) break;
    cursor = { limit: 100, updatedAt: c.updatedAt, nmID: c.nmID };
    await sleep(700);
  }
  process.stdout.write('\n');
  return cards;
}

async function fetchPrices() {
  const map = new Map();
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const r = await wb(
      `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=${limit}&offset=${offset}`
    );
    const list = r?.data?.listGoods || [];
    for (const g of list) map.set(g.nmID, pickPrice(g));
    if (list.length < limit) break;
    await sleep(700);
  }
  return map;
}

function pickPrice(g) {
  const sizes = g.sizes || [];
  const current = [];
  const base = [];
  for (const s of sizes) {
    const full = Number(s.price) || 0;
    const disc = Number(s.discountedPrice) || (full ? Math.round(full * (1 - (g.discount || 0) / 100)) : 0);
    if (disc) current.push(disc);
    if (full) base.push(full);
  }
  const price = current.length ? Math.min(...current) : 0;
  const old = base.length ? Math.min(...base) : 0;
  return { price, oldPrice: old > price ? old : 0 };
}

function cleanSize(s) {
  const v = String(s?.techSize ?? s?.wbSize ?? '').trim();
  return v && v !== '0' ? v : 'Один размер';
}

function toProduct(card, priceInfo) {
  // Автоматическая обработка размеров
  const rawSizes = card.sizes || [];
  const sizesMap = new Map();

  for (const s of rawSizes) {
    const sizeName = cleanSize(s);
    // Проверяем наличие на складе по данным карточки и штрихкодов
    const hasSkus = Array.isArray(s.skus) && s.skus.length > 0;
    // Если размер присутствует в карточке WB, считаем его доступным, если не указано обратное
    sizesMap.set(sizeName, {
      size: sizeName,
      available: hasSkus
    });
  }

  const sizes = Array.from(sizesMap.values());

  const attrs = (card.characteristics || [])
    .map((c) => ({
      name: String(c.name || '').trim(),
      value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? ''),
    }))
    .filter((a) => a.name && a.value && a.value.length <= 70)
    .slice(0, 10);

  return {
    id: String(card.nmID),
    sku: card.vendorCode || '',
    title: (card.title || card.subjectName || 'Товар').trim(),
    brand: card.brand || '',
    category: card.subjectName || 'Другое',
    description: (card.description || '').trim(),
    price: priceInfo?.price || 0,
    oldPrice: priceInfo?.oldPrice || 0,
    sizes: sizes.length ? sizes : [{ size: 'Один размер', available: true }],
    images: (card.photos || []).map((p) => p.big || p.c516x688 || p.c246x328).filter(Boolean),
    attrs,
  };
}

function applyOverride(p, o) {
  if (!o) return p;
  const { soldOutSizes, ...rest } = o;
  const out = { ...p, ...rest };
  if (Array.isArray(soldOutSizes)) {
    out.sizes = out.sizes.map((s) => ({ ...s, available: !soldOutSizes.includes(s.size) }));
  }
  return out;
}

async function downloadImages(products) {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const jobs = [];
  for (const p of products) {
    p.images = p.images.slice(0, maxPhotos);
    p.images.forEach((url, i) => {
      if (!/^https?:/i.test(url)) return;
      const ext = (url.split('?')[0].match(/\.(webp|jpe?g|png)$/i) || [, 'webp'])[1].toLowerCase();
      const rel = `img/${p.id}/${i + 1}.${ext}`;
      jobs.push({ p, i, url, rel });
    });
  }
  let done = 0;
  let failed = 0;
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const j = queue.shift();
      const file = path.join(ROOT, 'public', j.rel);
      try {
        if (!fs.existsSync(file)) {
          const res = await fetch(j.url);
          if (!res.ok) throw new Error(String(res.status));
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        }
        j.p.images[j.i] = j.rel;
      } catch {
        failed++;
      }
      process.stdout.write(`\rФото: ${++done}/${jobs.length}`);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (jobs.length) process.stdout.write('\n');
}

async function main() {
  if (!token) {
    console.error('Не найден WB_TOKEN.');
    process.exit(1);
  }

  console.log('Загружаю карточки из Wildberries…');
  const cards = await fetchCards();
  console.log('Загружаю цены…');
  let prices = new Map();
  try {
    prices = await fetchPrices();
  } catch (e) {
    console.warn(`Ошибка цен: ${e.message}`);
  }

  const overrides = fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')) : {};

  let products = cards.map((c) => applyOverride(toProduct(c, prices.get(c.nmID)), overrides[String(c.nmID)]));

  products = products.filter((p) => !p.hidden && p.price > 0);

  if (!skipImages) await downloadImages(products);

  const out = { currency: 'RUB', updatedAt: new Date().toISOString(), products };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, OUT);

  console.log(`Успешно обновлено ${products.length} товаров.`);
}

main().catch((e) => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
