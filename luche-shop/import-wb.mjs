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
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnv();

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name) => argv.includes(name);

const downloadImageFiles = flag('--download-images');
const maxPhotos = Number(opt('--max-photos') || 5);
const token = process.env.WB_TOKEN;
const marketplaceToken = token;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelaySeconds(res, attempt) {
  const retry = Number(res.headers.get('X-Ratelimit-Retry'));
  const retryAfter = Number(res.headers.get('Retry-After'));
  const reset = Number(res.headers.get('X-Ratelimit-Reset'));

  const serverDelay = [retry, retryAfter, reset]
    .find((v) => Number.isFinite(v) && v > 0);

  return serverDelay
    ? Math.ceil(serverDelay)
    : Math.min(180, 10 * (2 ** (attempt - 1)));
}

async function requestWB(
  url,
  { method = 'GET', body, requestToken = token, service = 'WB' } = {}
) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: requestToken,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const delaySeconds = retryDelaySeconds(res, attempt);
      const details = await res.text().catch(() => '');

      console.warn(
        `[${service} 429] Повтор через ${delaySeconds} сек. ` +
        `(попытка ${attempt}/5)`
      );

      if (attempt === 5) {
        throw new Error(
          `${service}: лимит запросов после 5 попыток (${url}). ${details.slice(0, 250)}`
        );
      }

      await sleep(delaySeconds * 1000);
      continue;
    }

    if (res.status === 204) return null;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `${service} ${res.status} на ${url}: ${text.slice(0, 300)}`
      );
    }

    return res.json();
  }

  throw new Error(`${service}: исчерпаны попытки запроса (${url})`);
}

async function wb(url, options = {}) {
  return requestWB(url, {
    ...options,
    requestToken: token,
    service: 'WB',
  });
}

async function wbMarketplace(url, options = {}) {
  if (!marketplaceToken) {
    throw new Error('Не найден WB_TOKEN.');
  }

  return requestWB(url, {
    ...options,
    requestToken: marketplaceToken,
    service: 'WB Marketplace',
  });
}

// МойСклад: остатки «доступно к продаже» (freeStock).
const moyskladToken = process.env.MOYSKLAD_TOKEN;

async function moyskladRequest(url) {
  if (!moyskladToken) throw new Error('Не найден MOYSKLAD_TOKEN.');
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${moyskladToken}`,
      Accept: 'application/json;charset=utf-8',
      'Content-Type': 'application/json',
      'X-Lognex-Remap-Beta-Feature': 'assortmentWithoutStock',
    },
  });
  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!res.ok) {
    throw new Error(`МойСклад ${res.status}: ${String(raw).slice(0, 500)}`);
  }
  return data;
}

function normalizeMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, '')
    .trim();
}

function moyskladSize(item) {
  const characteristics = item.characteristics?.rows
    || item.characteristics || [];
  for (const c of characteristics) {
    const name = String(c.name || c.characteristic?.name || '').toLowerCase();
    if (name.includes('размер')) {
      const value = c.value?.name ?? c.value ?? c.characteristic?.value;
      if (value != null && String(value).trim()) return String(value).trim();
    }
  }
  const name = String(item.name || item.product?.name || '');
  const match = name.match(/(?:размер\s*)?([0-9]{2,3}\s*[-–—]\s*[0-9]{2,3}|[0-9]{2,3})\s*$/i);
  return match ? match[1].replace(/\s+/g, '') : '';
}

function hrefId(href) {
  const match = String(href || '').match(/([a-f0-9-]{30,})\/?$/i);
  return match ? match[1] : '';
}

async function fetchMoyskladStocks(cards) {
  const assortment = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await moyskladRequest(
      `https://api.moysklad.ru/api/remap/1.2/entity/assortment?limit=1000&offset=${offset}`
    );
    const rows = page?.rows;
    if (!Array.isArray(rows)) throw new Error('МойСклад: неожиданный ответ assortment.');
    assortment.push(...rows);
    if (rows.length < 1000) break;
    await sleep(300);
  }

  const stockReport = await moyskladRequest(
    'https://api.moysklad.ru/api/remap/1.2/report/stock/all/current?stockType=freeStock&include=zeroLines'
  );
  // Краткий отчёт /report/stock/all/current возвращает массив строк,
  // а не объект с rows. Оставляем поддержку старого формата на всякий случай.
  const stockRows = Array.isArray(stockReport)
    ? stockReport
    : (stockReport?.rows ?? stockReport?.data?.rows);
  if (!Array.isArray(stockRows)) {
    const shape = stockReport && typeof stockReport === 'object'
      ? Object.keys(stockReport).join(', ')
      : typeof stockReport;
    throw new Error(`МойСклад: неожиданный формат отчёта остатков (${shape}).`);
  }

  const stockById = new Map();
  for (const row of stockRows) {
    // В текущем кратком отчёте ID позиции приходит прямо в assortmentId.
    // В других вариантах ответа может приходить ссылка assortment.meta.href.
    const id = String(row.assortmentId || '').trim()
      || hrefId(row.assortment?.meta?.href || row.assortment?.href || row.meta?.href);
 const rawFreeStock = row.freeStock;
const quantity = Number(rawFreeStock);
if (
  rawFreeStock === undefined ||
  rawFreeStock === null ||
  rawFreeStock === '' ||
  typeof rawFreeStock === 'object' ||
  !Number.isFinite(quantity)
) {
  console.error(
    '[МойСклад] Пример строки отчёта:',
    JSON.stringify(row, null, 2).slice(0, 1500)
  );
  throw new Error('МойСклад: некорректное значение freeStock.');
}
stockById.set(id, quantity);

  const moyByPair = new Map();
  for (const item of assortment) {
    const article = normalizeMatch(item.article);
    const size = normalizeMatch(moyskladSize(item));
    const id = hrefId(item.meta?.href);
    if (!article || !size || !id) continue;
    const key = `${article}::${size}`;
    const list = moyByPair.get(key) || [];
    list.push({ id, name: item.name || '', article: item.article, size: moyskladSize(item) });
    moyByPair.set(key, list);
  }

  const result = new Map();
  let matched = 0;
  let unmatched = 0;
  for (const card of cards) {
    const article = normalizeMatch(card.vendorCode);
    for (const raw of (card.sizes || [])) {
      const chrtId = Number(raw.chrtID || raw.chrtId || 0);
      const size = normalizeMatch(raw.techSize ?? raw.wbSize ?? 'Один размер');
      const key = `${article}::${size}`;
      const candidates = moyByPair.get(key) || [];
      if (candidates.length === 1) {
        const item = candidates[0];
        result.set(`${card.nmID}:${chrtId}`, stockById.get(item.id) ?? 0);
        matched++;
      } else {
        unmatched++;
        console.warn(`[МойСклад] Нет однозначного совпадения: артикул=${card.vendorCode}, размер=${raw.techSize ?? raw.wbSize ?? 'Один размер'} (найдено: ${candidates.length})`);
      }
    }
  }

  if (!matched) throw new Error('МойСклад: не найдено ни одного однозначного совпадения по артикулу и размеру. Старые остатки сохранены.');
  console.log(`МойСклад: совпадений ${matched}, без совпадения ${unmatched}; источник freeStock.`);
  return result;
}

async function fetchCards() {
  const cards = [];
  let cursor = { limit: 100 };

  for (;;) {
    const r = await wb(
      'https://content-api.wildberries.ru/content/v2/get/cards/list?locale=ru',
      {
        method: 'POST',
        body: {
          settings: {
            cursor,
            filter: { withPhoto: -1 },
          },
        },
      }
    );

    const list = r.cards || [];
    cards.push(...list);

    const c = r.cursor || {};

    process.stdout.write(
      `\rКарточек получено: ${cards.length}`
    );

    if (list.length < 100 || !c.nmID) break;

    cursor = {
      limit: 100,
      updatedAt: c.updatedAt,
      nmID: c.nmID,
    };

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

    for (const g of list) {
      map.set(g.nmID, pickPrice(g));
    }

    if (list.length < limit) break;

    await sleep(700);
  }

  return map;
}

function pickPrice(g) {
  const bySizeId = new Map();
  const bySizeName = new Map();
  const candidates = [];

  for (const size of (g.sizes || [])) {
    const full = Number(size.price) || 0;
    const discountedValue = Number(size.discountedPrice);

    const discounted =
      Number.isFinite(discountedValue) && discountedValue > 0
        ? discountedValue
        : (
          full
            ? Math.round(
                full * (1 - (Number(g.discount) || 0) / 100)
              )
            : 0
        );

    const item = {
      price: discounted,
      oldPrice: full > discounted ? full : 0,
    };

    const sizeId = Number(size.sizeID);
    const sizeName = String(size.techSizeName || '').trim();

    if (Number.isSafeInteger(sizeId) && sizeId > 0) {
      bySizeId.set(sizeId, item);
    }

    if (sizeName) bySizeName.set(sizeName, item);

    if (discounted > 0) candidates.push(item);
  }

  candidates.sort((a, b) => a.price - b.price);

  const lowest = candidates[0] || {
    price: 0,
    oldPrice: 0,
  };

  return {
    bySizeId,
    bySizeName,
    price: lowest.price,
    oldPrice: lowest.oldPrice,
  };
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

    const stockKey = `${card.nmID}:${chrtId}`;
    const stock = chrtId > 0 && stockMap.has(stockKey)
      ? stockMap.get(stockKey)
      : null;

    const sizePrice =
      (chrtId > 0 ? priceInfo?.bySizeId?.get(chrtId) : null)
      || priceInfo?.bySizeName?.get(sizeName)
      || {
        price: priceInfo?.price || 0,
        oldPrice: priceInfo?.oldPrice || 0,
      };

    const previous = sizesMap.get(sizeName);

    if (previous) {
      if (stock !== null) previous.stock = (previous.stock ?? 0) + stock;

      if (chrtId > 0) previous.chrtIds.push(chrtId);

      if (
        sizePrice.price > 0 &&
        (!previous.price || sizePrice.price < previous.price)
      ) {
        previous.price = sizePrice.price;
        previous.oldPrice = sizePrice.oldPrice;
      }

      previous.available = previous.stock !== null && previous.stock > 0;
    } else {
      sizesMap.set(sizeName, {
        size: sizeName,
        chrtId,
        chrtIds: chrtId > 0 ? [chrtId] : [],
        stock,
        available: stock !== null && stock > 0,
        price: sizePrice.price || 0,
        oldPrice: sizePrice.oldPrice || 0,
      });
    }
  }

  const sizes = Array.from(sizesMap.values());

  const pricedSizes = sizes
    .filter((size) => size.price > 0)
    .sort((a, b) => a.price - b.price);

  const lowest = pricedSizes[0] || {
    price: priceInfo?.price || 0,
    oldPrice: priceInfo?.oldPrice || 0,
  };

  const attrs = (card.characteristics || [])
    .map((c) => ({
      name: String(c.name || '').trim(),
      value: Array.isArray(c.value)
        ? c.value.join(', ')
        : String(c.value ?? ''),
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
    price: lowest.price,
    oldPrice: lowest.oldPrice,
    sizes: sizes.length
      ? sizes
      : [{
          size: 'Один размер',
          stock: 0,
          available: false,
          price: lowest.price,
          oldPrice: lowest.oldPrice,
        }],
    images: (card.photos || [])
      .map((p) => p.big || p.c516x688 || p.c246x328)
      .filter(Boolean),
    attrs,
  };
}

function applyOverride(p, o) {
  if (!o) return p;

  const { soldOutSizes, ...rest } = o;
  const out = { ...p, ...rest };

  if (Object.prototype.hasOwnProperty.call(rest, 'price')) {
    out.sizes = out.sizes.map((s) => ({
      ...s,
      price: Number(rest.price) || 0,
    }));
  }

  if (Object.prototype.hasOwnProperty.call(rest, 'oldPrice')) {
    out.sizes = out.sizes.map((s) => ({
      ...s,
      oldPrice: Number(rest.oldPrice) || 0,
    }));
  }

  if (Array.isArray(soldOutSizes)) {
    out.sizes = out.sizes.map((s) => ({
      ...s,
      available: !soldOutSizes.includes(s.size),
    }));
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

      const ext = (
        url.split('?')[0].match(/\.(webp|jpe?g|png)$/i) || [, 'webp']
      )[1].toLowerCase();

      const rel = `img/${p.id}/${i + 1}.${ext}`;

      jobs.push({ p, i, url, rel });
    });
  }

  let done = 0;
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

          fs.writeFileSync(
            file,
            Buffer.from(await res.arrayBuffer())
          );
        }

        j.p.images[j.i] = j.rel;
      } catch {
        // Если фото недоступно, оставляем исходную ссылку.
      }

      process.stdout.write(
        `\rФото: ${++done}/${jobs.length}`
      );
    }
  }

  await Promise.all([
    worker(),
    worker(),
    worker(),
    worker(),
  ]);

  if (jobs.length) process.stdout.write('\n');
}

async function supabaseRequest(table, query, body) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');

  const key =
    process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || '';

  if (!url || !key) {
    throw new Error(
      'Для импорта в Supabase задайте SUPABASE_URL и SUPABASE_SECRET_KEY.'
    );
  }

  const res = await fetch(
    `${url}/rest/v1/${table}${query ? `?${query}` : ''}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
  );

  const raw = await res.text();

  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    throw new Error(
      `Supabase ${table} ${res.status}: ${data?.message || raw}`
    );
  }

  return data;
}

async function saveProductsToSupabase(
  products,
  { updateStocks = true } = {}
) {
  const productRows = products.map((p) => ({
    wb_nm_id: Number(p.id),
    name: p.title,
    description: p.description || null,
    brand: p.brand || null,
    category: p.category || 'Другое',
    attributes: p.attrs || [],
    images: p.images || [],
    image_url: p.images?.[0] || null,
    price: Number(p.price) || 0,
    old_price: Number(p.oldPrice) || 0,
    is_active: true,
  }));

  if (!productRows.length) {
    throw new Error(
      'Импорт дал 0 товаров. Supabase не будет изменён.'
    );
  }

  const savedProducts = await supabaseRequest(
    'products',
    'on_conflict=wb_nm_id&select=id,wb_nm_id',
    productRows
  );

  const productIds = new Map(
    (savedProducts || []).map((p) => [
      Number(p.wb_nm_id),
      p.id,
    ])
  );

  let variantCount = 0;
  let stockCount = 0;

  for (const p of products) {
    const productId = productIds.get(Number(p.id));

    if (!productId) {
      throw new Error(
        `Не удалось получить ID товара WB ${p.id} из Supabase.`
      );
    }

    const variants = (p.sizes || []).map((size) => ({
      product_id: productId,
      wb_chrt_id: Number(size.chrtId) > 0
        ? Number(size.chrtId)
        : null,
      sku: p.sku || null,
      size: String(size.size || 'Один размер'),
      price: Number(size.price) || Number(p.price) || 0,
    }));

    const withChrt = variants.filter((v) => v.wb_chrt_id);
    const withoutChrt = variants.filter((v) => !v.wb_chrt_id);

    let savedVariants = [];

    if (withChrt.length) {
      savedVariants.push(
        ...await supabaseRequest(
          'variants',
          'on_conflict=wb_chrt_id',
          withChrt
        )
      );
    }

    if (withoutChrt.length) {
      savedVariants.push(
        ...await supabaseRequest(
          'variants',
          '',
          withoutChrt
        )
      );
    }

    variantCount += savedVariants.length;

    // Записываем только однозначно сопоставленные остатки МойСклад.
    // Несопоставленные варианты не обнуляем: старые значения сохраняются.
    if (updateStocks) {
      const stockRows = savedVariants.flatMap((v) => {
        const source = (p.sizes || []).find((x) =>
          v.wb_chrt_id
            ? (Number(x.chrtId) === Number(v.wb_chrt_id)
              || (x.chrtIds || []).includes(Number(v.wb_chrt_id)))
            : String(x.size) === String(v.size)
        );
        if (!source || source.stock === null || source.stock === undefined) return [];
        return [{
          variant_id: v.id,
          warehouse: 'МойСклад (доступно к продаже)',
          quantity: Math.max(0, Number(source.stock) || 0),
        }];
      });

      if (stockRows.length) {
        await supabaseRequest(
          'stocks',
          'on_conflict=variant_id,warehouse',
          stockRows
        );

        stockCount += stockRows.length;
      }
    }
  }

  console.log(
    `Supabase: товаров ${productRows.length}, ` +
    `вариантов ${variantCount}, остатков обновлено ${stockCount}.`
  );

  if (!updateStocks) {
    console.warn(
      'Остатки не обновлялись. Существующие данные сохранены.'
    );
  }
}

async function main() {
  if (!token) {
    throw new Error('Не найден WB_TOKEN.');
  }

  console.log('Загружаю карточки из Wildberries…');
  const cards = await fetchCards();

  console.log('Загружаю цены…');
  const prices = await fetchPrices();

  console.log('Загружаю остатки из МойСклад…');

  let stockMap = new Map();
  let stocksUpdated = false;
  try {
    stockMap = await fetchMoyskladStocks(cards);
    stocksUpdated = true;
  } catch (e) {
    console.warn(
      `Не удалось обновить остатки из МойСклад: ${e.message}. ` +
      'Продолжаю импорт карточек, старые остатки сохраняются.'
    );
  }

  const overrides = fs.existsSync(OVERRIDES)
    ? JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'))
    : {};

  let products = cards.map((c) =>
    applyOverride(
      toProduct(c, prices.get(c.nmID), stockMap),
      overrides[String(c.nmID)]
    )
  );

  products = products.filter(
    (p) => !p.hidden && p.price > 0
  );

  if (!products.length) {
    throw new Error(
      'После получения карточек не осталось товаров с корректной ценой.'
    );
  }

  if (downloadImageFiles) {
    await downloadImages(products);
  }

  await saveProductsToSupabase(products, {
    updateStocks: stocksUpdated,
  });

  const out = {
    currency: 'RUB',
    updatedAt: new Date().toISOString(),
    stockCheckedAt: stocksUpdated
      ? new Date().toISOString()
      : null,
    stockSource: stocksUpdated
      ? 'МойСклад (доступно к продаже)'
      : 'Не обновлялись: ошибка или нет совпадений в МойСклад',
    products,
  };

  fs.mkdirSync(path.dirname(OUT), {
    recursive: true,
  });

  const tmp = OUT + '.tmp';

  fs.writeFileSync(
    tmp,
    JSON.stringify(out, null, 2)
  );

  fs.renameSync(tmp, OUT);

  console.log(
    `Успешно обновлено в Supabase: ${products.length} товаров.`
  );

  if (!stocksUpdated) {
    console.log(
      'Внимание: остатки не обновлены. Проверьте их отдельно перед продажей.'
    );
  }
}

main().catch((e) => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
