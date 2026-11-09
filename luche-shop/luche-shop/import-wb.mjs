#!/usr/bin/env node
// Импорт карточек товаров из кабинета Wildberries в public/products.json
//
// Запуск:
//   WB_TOKEN=ваш_токен node import-wb.mjs
//   (или положите WB_TOKEN в файл .env)
//
// Проверка без интернета на примере:
//   node import-wb.mjs --cards sample/wb-cards.json --prices sample/wb-prices.json --no-images
//
// Опции:
//   --no-images        не скачивать фото (в каталоге останутся ссылки на WB)
//   --max-photos N     сколько фото на товар скачивать (по умолчанию 5)
//
// Ручные правки (скрыть товар, поменять цену, убрать размер) пишите в overrides.json —
// они применяются поверх данных WB и не затираются при повторном импорте.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'public', 'products.json');
const OVERRIDES = path.join(ROOT, 'overrides.json');
const IMG_DIR = path.join(ROOT, 'public', 'img');

// ---------- аргументы и .env ----------
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

const cardsFile = opt('--cards');
const pricesFile = opt('--prices');
const skipImages = flag('--no-images');
const maxPhotos = Number(opt('--max-photos') || 5);
const token = process.env.WB_TOKEN;

// ---------- работа с API WB ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wb(url, { method = 'GET', body } = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      await sleep(1500 * attempt); // лимит запросов — подождём и повторим
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `WB отклонил токен (${res.status}). Проверьте, что токен создан с доступом к разделам «Контент» и «Цены и скидки». ${text}`
        );
      }
      throw new Error(`WB ${res.status} на ${url}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`WB: слишком много запросов подряд (${url})`);
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

// ---------- преобразование карточки ----------
function cleanSize(s) {
  const v = String(s?.techSize ?? s?.wbSize ?? '').trim();
  return v && v !== '0' ? v : 'Один размер';
}

function toProduct(card, priceInfo) {
  const sizes = [...new Set((card.sizes || []).map(cleanSize))].map((size) => ({ size, available: true }));
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

// ---------- фото ----------
async function downloadImages(products) {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const jobs = [];
  for (const p of products) {
    p.images = p.images.slice(0, maxPhotos);
    p.images.forEach((url, i) => {
      if (!/^https?:/i.test(url)) return; // уже локальный путь
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
        failed++; // оставляем ссылку на WB, магазин всё равно покажет фото
      }
      process.stdout.write(`\rФото: ${++done}/${jobs.length}`);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (jobs.length) process.stdout.write('\n');
  if (failed) console.warn(`Не удалось скачать фото: ${failed} (останутся ссылки на WB)`);
}

// ---------- главная ----------
async function main() {
  let cards;
  let prices = new Map();

  if (cardsFile) {
    cards = JSON.parse(fs.readFileSync(path.resolve(cardsFile), 'utf8'));
    cards = cards.cards || cards;
    if (pricesFile) {
      const list = JSON.parse(fs.readFileSync(path.resolve(pricesFile), 'utf8'));
      for (const g of list?.data?.listGoods || list) prices.set(g.nmID, pickPrice(g));
    }
  } else {
    if (!token) {
      console.error('Не найден WB_TOKEN. Укажите токен: WB_TOKEN=... node import-wb.mjs (или в файле .env)');
      process.exit(1);
    }
    console.log('Загружаю карточки из Wildberries…');
    cards = await fetchCards();
    console.log('Загружаю цены…');
    try {
      prices = await fetchPrices();
    } catch (e) {
      console.warn(`Не получилось взять цены из WB: ${e.message}\nЦены можно задать вручную в overrides.json (поле "price").`);
    }
  }

  const overrides = fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')) : {};

  let products = cards.map((c) => applyOverride(toProduct(c, prices.get(c.nmID)), overrides[String(c.nmID)]));

  const hidden = products.filter((p) => p.hidden).length;
  products = products.filter((p) => !p.hidden);

  const noPrice = products.filter((p) => !(p.price > 0));
  if (noPrice.length) {
    console.warn(
      `Без цены (в каталог не попали): ${noPrice.map((p) => p.sku || p.id).join(', ')}\n` +
        `Задайте цену в overrides.json: { "${noPrice[0].id}": { "price": 1990 } }`
    );
    products = products.filter((p) => p.price > 0);
  }

  if (!skipImages) await downloadImages(products);

  const out = { currency: 'RUB', updatedAt: new Date().toISOString(), products };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, OUT);

  console.log(`Готово: ${products.length} товаров → public/products.json` + (hidden ? ` (скрыто вручную: ${hidden})` : ''));
}

main().catch((e) => {
  console.error('\nОшибка импорта:', e.message);
  process.exit(1);
});
