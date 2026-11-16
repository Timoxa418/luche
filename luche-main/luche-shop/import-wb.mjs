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
// Один WB_TOKEN используется для всех API, если в нём включены нужные права, включая «Аналитику».
const analyticsToken = process.env.WB_ANALYTICS_TOKEN || token;
const marketplaceToken = token;
const configuredWarehouseId = process.env.WB_WAREHOUSE_ID ? Number(process.env.WB_WAREHOUSE_ID) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelaySeconds(res, attempt) {
  const retry = Number(res.headers.get('X-Ratelimit-Retry'));
  const retryAfter = Number(res.headers.get('Retry-After'));
  const reset = Number(res.headers.get('X-Ratelimit-Reset'));
  // Приоритет — точное время ожидания, которое вернул сам Wildberries.
  const serverDelay = [retry, retryAfter, reset].find((v) => Number.isFinite(v) && v > 0);
  return serverDelay ? Math.ceil(serverDelay) : Math.min(180, 10 * (2 ** (attempt - 1)));
}

async function requestWB(url, { method = 'GET', body, requestToken = token, service = 'WB' } = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: requestToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const delaySeconds = retryDelaySeconds(res, attempt);
      const details = await res.text().catch(() => '');
      console.warn(
        `[${service} 429] ${method} ${url}; повтор через ${delaySeconds} сек. ` +
        `(попытка ${attempt}/5)` +
        (details ? `; ответ: ${details.slice(0, 250)}` : '')
      );
      if (attempt === 5) {
        throw new Error(`${service}: лимит запросов после 5 попыток (${url}). Подробности: ${details.slice(0, 250)}`);
      }
      await sleep(delaySeconds * 1000);
      continue;
    }

    if (res.status === 204) return null;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${service} ${res.status} на ${url}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`${service}: исчерпаны попытки запроса (${url})`);
}

async function wb(url, options = {}) {
  return requestWB(url, { ...options, requestToken: token, service: 'WB' });
}

async function wbMarketplace(url, options = {}) {
  if (!marketplaceToken) {
    throw new Error('Не найден WB_TOKEN. Убедитесь, что токен имеет права на «Маркетплейс».');
  }
  return requestWB(url, { ...options, requestToken: marketplaceToken, service: 'WB Marketplace' });
}

async function wbAnalytics(url, options = {}) {
  if (!analyticsToken) {
    throw new Error('У WB_TOKEN нет доступа к API аналитики. Проверьте, что для этого токена включена категория «Аналитика».');
  }
  return requestWB(url, { ...options, requestToken: analyticsToken, service: 'WB Analytics' });
}

// Новый отчёт WB по остаткам именно на складах продавца. В отличие от старого
// Marketplace stocks API, не требует перечислять warehouseId и chrtId заранее.
async function fetchFbsStocks(cards) {
  const totals = new Map();
  const cardsByNmId = new Map(cards.map((card) => [Number(card.nmID), card]));
  const nmIds = [...cardsByNmId.keys()].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!nmIds.length) throw new Error('В карточках WB не найдены nmID для отчёта остатков.');

  let returnedRows = 0;
  let positiveRows = 0;
  const warehouses = new Map();
  const endpoint = 'https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/seller-warehouses';

  for (let i = 0; i < nmIds.length; i += 1000) {
    const batch = nmIds.slice(i, i + 1000);
    let offset = 0;
    const limit = 250000;
    for (;;) {
      const result = await wbAnalytics(endpoint, {
        method: 'POST',
        body: { nmIds: batch, limit, offset },
      });
      const items = result?.data?.items ?? result?.items;
      if (!Array.isArray(items)) {
        throw new Error('WB Analytics вернул пустой или неожиданный ответ по остаткам. Каталог не будет перезаписан нулями.');
      }
      if (items.length === 0 && offset === 0) {
        throw new Error('WB Analytics вернул 0 строк остатков. Каталог не будет перезаписан нулями. Проверьте токен и наличие данных в отчёте.');
      }

      for (const item of items) {
        const nmId = Number(item.nmId ?? item.nmID);
        const chrtId = Number(item.chrtId ?? item.chrtID);
        const quantity = Number(item.quantity);
        if (!cardsByNmId.has(nmId) || !Number.isSafeInteger(chrtId) || chrtId <= 0) continue;
        if (!Number.isFinite(quantity) || quantity < 0) {
          throw new Error(`WB Analytics вернул некорректный quantity для nmId=${nmId}, chrtId=${chrtId}: ${item.quantity}`);
        }
        totals.set(chrtId, (totals.get(chrtId) || 0) + quantity);
        returnedRows++;
        if (quantity > 0) positiveRows++;
        const whKey = String(item.warehouseId ?? item.warehouseName ?? 'unknown');
        const wh = warehouses.get(whKey) || { name: item.warehouseName || whKey, rows: 0, quantity: 0 };
        wh.rows++;
        wh.quantity += quantity;
        warehouses.set(whKey, wh);
      }

      if (items.length < limit) break;
      offset += items.length;
      await sleep(21000); // лимит WB Analytics: не чаще одного запроса в 20 секунд
    }
  }

  if (!returnedRows) {
    throw new Error('В отчёте WB Analytics не найдено ни одной строки по карточкам. Каталог не будет перезаписан.');
  }

  console.log(`Отчёт WB по складам продавца: строк ${returnedRows}, строк с количеством > 0: ${positiveRows}.`);
  for (const wh of warehouses.values()) console.log(`Склад продавца ${wh.name}: строк ${wh.rows}, всего доступно ${wh.quantity} шт.`);

  for (const card of cards) {
    const entries = (card.sizes || []).map((size) => {
      const chrtId = Number(size.chrtID || size.chrtId || 0);
      const label = String(size.techSize ?? size.wbSize ?? 'Один размер').trim() || 'Один размер';
      return chrtId > 0 ? `${label}[${chrtId}]=${totals.get(chrtId) ?? 0}` : `${label}[нет chrtId]`;
    });
    console.log(`[FBS] nmID=${card.nmID} vendorCode=${card.vendorCode || '-'}: ${entries.join(', ')}`);
  }

  return totals;
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
  // Цена продавца после его скидки. Цена конкретного покупателя WB может
  // отличаться из-за дополнительных скидок WB и WB Клуба.
  const candidates = sizes.map((s) => {
    const full = Number(s.price) || 0;
    const discounted = Number(s.discountedPrice) ||
      (full ? Math.round(full * (1 - (Number(g.discount) || 0) / 100)) : 0);
    return { price: discounted, oldPrice: full };
  }).filter((x) => x.price > 0);
  if (!candidates.length) return { price: 0, oldPrice: 0 };
  candidates.sort((a, b) => a.price - b.price);
  const best = candidates[0];
  return { price: best.price, oldPrice: best.oldPrice > best.price ? best.oldPrice : 0 };
}

function cleanSize(s) {
  const v = String(s?.techSize ?? s?.wbSize ?? '').trim();
  return v && v !== '0' ? v : 'Один размер';
}

function toProduct(card, priceInfo, stockMap) {
  const rawSizes = card.sizes || [];
  const sizesMap = new Map();
  for (const raw of rawSizes) {
    const sizeName = cleanSize(raw);
    const chrtId = Number(raw.chrtID || raw.chrtId || 0);
    const stock = chrtId > 0 ? (stockMap.get(chrtId) || 0) : 0;
    const previous = sizesMap.get(sizeName);
    if (previous) {
      previous.stock += stock;
      if (chrtId > 0) previous.chrtIds.push(chrtId);
      previous.available = previous.stock > 0;
    } else {
      sizesMap.set(sizeName, { size: sizeName, chrtId, chrtIds: chrtId > 0 ? [chrtId] : [], stock, available: stock > 0 });
    }
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
    sizes: sizes.length ? sizes : [{ size: 'Один размер', stock: 0, available: false }],
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
  if (!analyticsToken) {
    console.error('У WB_TOKEN нет доступа к API аналитики. Проверьте права токена в кабинете WB.');
    process.exit(1);
  }

  console.log('Загружаю карточки из Wildberries…');
  const cards = await fetchCards();
  console.log('Загружаю цены…');
  const prices = await fetchPrices();
  console.log('Загружаю остатки FBS…');
  const stockMap = await fetchFbsStocks(cards);

  const overrides = fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')) : {};

  let products = cards.map((c) => applyOverride(toProduct(c, prices.get(c.nmID), stockMap), overrides[String(c.nmID)]));

  products = products.filter((p) => !p.hidden && p.price > 0);

  if (!skipImages) await downloadImages(products);

  const out = { currency: 'RUB', updatedAt: new Date().toISOString(), stockCheckedAt: new Date().toISOString(), stockSource: 'Wildberries Analytics seller-warehouses report', products };
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
