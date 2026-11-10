#!/usr/bin/env node
// Luche — сервер мини-аппа: отдаёт витрину, создаёт счета на оплату, принимает оплату в боте.
// Без зависимостей, нужен Node.js 18+.  Запуск: node server.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

// ---------- настройки (.env) ----------
(function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const env = process.env;
const CFG = {
  port: Number(env.PORT || 3000),
  botToken: env.BOT_TOKEN || '',
  providerToken: env.PROVIDER_TOKEN || '',
  managerChatId: env.MANAGER_CHAT_ID || '',
  webappUrl: (env.WEBAPP_URL || '').replace(/\/$/, ''),
  currency: env.CURRENCY || 'RUB',
  shippingCost: Number(env.SHIPPING_COST || 0), // в рублях
  freeShippingFrom: Number(env.FREE_SHIPPING_FROM || 0), // 0 = бесплатной доставки нет
  shopName: env.SHOP_NAME || 'Luche',
  // чек по 54-ФЗ (нужен ЮKassa и подобным провайдерам). 0 = не отправлять
  receipt: env.RECEIPT === '1',
  taxSystemCode: Number(env.TAX_SYSTEM_CODE || 1),
  vatCode: Number(env.VAT_CODE || 1),
  dev: env.DEV === '1' || !env.BOT_TOKEN,
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- товары ----------
function loadCatalog() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'products.json'), 'utf8'));
    return new Map(d.products.map((p) => [p.id, p]));
  } catch {
    return new Map();
  }
}

// ---------- заказы (простой файл) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let orders = {};
try {
  orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
} catch {}
function saveOrders() {
  const tmp = ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
  fs.renameSync(tmp, ORDERS_FILE);
}
function nextOrderId() {
  const n = Object.keys(orders).length + 1001;
  return String(n);
}

// ---------- Telegram API ----------
async function tg(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${CFG.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description || res.status}`);
  return json.result;
}

// Проверка подписи данных, которые Telegram передаёт мини-аппу
function validateInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(CFG.botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
  if (age > 24 * 3600) return null;
  try {
    return JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
}

// ---------- создание заказа и счёта ----------
const kop = (rub) => Math.round(rub * 100);
const money = (rub) => `${Math.round(rub).toLocaleString('ru-RU')} ₽`;

function buildOrder(items, user) {
  const catalog = loadCatalog();
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new HttpError(400, 'Корзина пуста');
  const lines = [];
  for (const it of items) {
    const p = catalog.get(String(it.id));
    if (!p) throw new HttpError(400, 'Товар больше не продаётся — обновите страницу');
    const size = String(it.size || '');
    const s = p.sizes.find((x) => x.size === size);
    if (!s || !s.available || (Number.isFinite(Number(s.stock)) && Number(s.stock) <= 0)) {
      throw new HttpError(400, `Размера ${size} нет в наличии: ${p.title}`);
    }
    const qty = Math.floor(Number(it.qty));
    if (!(qty >= 1 && qty <= 20)) throw new HttpError(400, 'Неверное количество');
    if (Number.isFinite(Number(s.stock)) && qty > Number(s.stock)) {
      throw new HttpError(409, `Доступно только ${s.stock} шт. размера ${size}: ${p.title}`);
    }
    lines.push({ id: p.id, sku: p.sku, title: p.title, size, qty, price: p.price });
  }
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const shipping = CFG.freeShippingFrom && subtotal >= CFG.freeShippingFrom ? 0 : CFG.shippingCost;
  return {
    id: nextOrderId(),
    status: 'new',
    createdAt: new Date().toISOString(),
    user: user ? { id: user.id, username: user.username || '', name: [user.first_name, user.last_name].filter(Boolean).join(' ') } : null,
    lines,
    subtotal,
    shipping,
    total: subtotal + shipping,
  };
}

async function createInvoice(order) {
  const prices = order.lines.map((l) => ({
    label: `${l.title} (${l.size}) × ${l.qty}`.slice(0, 120),
    amount: kop(l.price * l.qty),
  }));
  if (order.shipping > 0) prices.push({ label: 'Доставка', amount: kop(order.shipping) });

  const params = {
    title: `Заказ ${CFG.shopName} №${order.id}`,
    description: order.lines.map((l) => `${l.title} (${l.size}) × ${l.qty}`).join(', ').slice(0, 250),
    payload: `order:${order.id}`,
    provider_token: CFG.providerToken,
    currency: CFG.currency,
    prices,
    need_name: true,
    need_phone_number: true,
    need_email: CFG.receipt,
    need_shipping_address: true,
    send_phone_number_to_provider: CFG.receipt,
    send_email_to_provider: CFG.receipt,
    is_flexible: false,
  };

  if (CFG.receipt) {
    const items = order.lines.map((l) => ({
      description: l.title.slice(0, 128),
      quantity: l.qty,
      amount: { value: l.price.toFixed(2), currency: CFG.currency },
      vat_code: CFG.vatCode,
      payment_mode: 'full_payment',
      payment_subject: 'commodity',
    }));
    if (order.shipping > 0) {
      items.push({
        description: 'Доставка',
        quantity: 1,
        amount: { value: order.shipping.toFixed(2), currency: CFG.currency },
        vat_code: CFG.vatCode,
        payment_mode: 'full_payment',
        payment_subject: 'service',
      });
    }
    params.provider_data = JSON.stringify({ receipt: { tax_system_code: CFG.taxSystemCode, items } });
  }

  return tg('createInvoiceLink', params);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- бот: обновления ----------
function orderText(o, info) {
  const lines = o.lines.map((l) => `• ${l.title} — размер ${l.size} × ${l.qty} = ${money(l.price * l.qty)}${l.sku ? ` (${l.sku})` : ''}`);
  const who = o.user ? `${o.user.name}${o.user.username ? ' @' + o.user.username : ''} (id ${o.user.id})` : '—';
  const a = info?.shipping_address;
  return [
    `🛍 Новый оплаченный заказ №${o.id}`,
    '',
    ...lines,
    o.shipping ? `Доставка: ${money(o.shipping)}` : 'Доставка: бесплатно',
    `Итого: ${money(o.total)}`,
    '',
    `Покупатель: ${info?.name || who}`,
    info?.phone_number ? `Телефон: ${info.phone_number}` : '',
    info?.email ? `Email: ${info.email}` : '',
    a ? `Адрес: ${a.country_code}, ${a.state ? a.state + ', ' : ''}${a.city}, ${a.street_line1}${a.street_line2 ? ', ' + a.street_line2 : ''}, ${a.post_code}` : '',
    `Telegram: ${who}`,
  ]
    .filter((x) => x !== '')
    .join('\n');
}

async function handleUpdate(u) {
  if (u.pre_checkout_query) {
    const q = u.pre_checkout_query;
    const id = String(q.invoice_payload || '').replace('order:', '');
    const o = orders[id];
    if (!o || o.status === 'paid') {
      await tg('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: false, error_message: 'Заказ не найден или уже оплачен. Оформите заново.' });
    } else {
      await tg('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: true });
    }
    return;
  }

  const m = u.message;
  if (!m) return;

  if (m.successful_payment) {
    const sp = m.successful_payment;
    const id = String(sp.invoice_payload || '').replace('order:', '');
    const o = orders[id];
    if (!o) {
      log('Оплата по неизвестному заказу', sp.invoice_payload);
      return;
    }
    o.status = 'paid';
    o.paidAt = new Date().toISOString();
    o.payment = { charge: sp.provider_payment_charge_id, tgCharge: sp.telegram_payment_charge_id, total: sp.total_amount / 100, currency: sp.currency };
    o.customer = sp.order_info || null;
    saveOrders();
    log(`Заказ №${id} оплачен: ${money(o.total)}`);
    await tg('sendMessage', { chat_id: m.chat.id, text: `Спасибо! Заказ №${id} оплачен 💛\nМы свяжемся с вами по поводу доставки.` }).catch(() => {});
    if (CFG.managerChatId) await tg('sendMessage', { chat_id: CFG.managerChatId, text: orderText(o, sp.order_info) }).catch((e) => log('Не удалось уведомить менеджера:', e.message));
    return;
  }

  if (m.text && m.text.startsWith('/start') && CFG.webappUrl) {
    await tg('sendMessage', {
      chat_id: m.chat.id,
      text: `Добро пожаловать в ${CFG.shopName}! Детская одежда с заботой о малышах 🌤\nОткрывайте каталог:`,
      reply_markup: { inline_keyboard: [[{ text: '🛍 Открыть магазин', web_app: { url: CFG.webappUrl } }]] },
    });
  }
}

async function pollLoop() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'pre_checkout_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          await handleUpdate(u);
        } catch (e) {
          log('Ошибка обработки:', e.message);
        }
      }
    } catch (e) {
      log('getUpdates:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function setupBot() {
  try {
    await tg('deleteWebhook'); // чтобы работал getUpdates
    if (CFG.webappUrl) {
      await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Магазин', web_app: { url: CFG.webappUrl } } });
    }
    const me = await tg('getMe');
    log(`Бот @${me.username} запущен`);
  } catch (e) {
    log('Не удалось настроить бота:', e.message);
  }
  pollLoop();
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// простой ограничитель: не больше 10 счетов в минуту с одного адреса
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 10;
}

async function handleInvoice(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  if (rateLimited(ip)) throw new HttpError(429, 'Слишком часто, попробуйте через минуту');

  const body = JSON.parse((await readBody(req)) || '{}');
  const user = validateInitData(body.initData);
  if (!user && !CFG.dev) throw new HttpError(401, 'Откройте магазин из Telegram');

  const order = buildOrder(body.items, user);

  if (CFG.dev && (!CFG.botToken || !CFG.providerToken)) {
    // режим разработки: показываем, что получилось бы, без обращения к Telegram
    log(`[dev] заказ ${order.id}: ${money(order.total)}`);
    return sendJson(res, 200, { dev: true, order });
  }
  if (!CFG.providerToken) throw new HttpError(500, 'Не задан PROVIDER_TOKEN (токен платёжного провайдера из BotFather)');

  orders[order.id] = order;
  saveOrders();
  const link = await createInvoice(order);
  sendJson(res, 200, { link, orderId: order.id });
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    const cache = rel.startsWith('/img/') ? 'public, max-age=604800' : 'no-cache';
    send(res, 200, buf, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(res, 200, { shopName: CFG.shopName, currency: CFG.currency, shippingCost: CFG.shippingCost, freeShippingFrom: CFG.freeShippingFrom, dev: CFG.dev });
    }
    if (req.method === 'POST' && url.pathname === '/api/invoice') return await handleInvoice(req, res);
    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 405, 'Method not allowed');
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    log('Ошибка:', e.message);
    sendJson(res, 500, { error: 'Что-то пошло не так, попробуйте ещё раз' });
  }
});

// Периодически обновляем каталог из WB без повторного скачивания фотографий.
function startWildberriesSync() {
  if (!env.WB_TOKEN || !(env.WB_MARKETPLACE_TOKEN || env.WB_TOKEN)) {
    log('Автосинхронизация WB отключена: не заданы токены WB_TOKEN / WB_MARKETPLACE_TOKEN');
    return;
  }
  const intervalMs = Math.max(60_000, Number(env.WB_SYNC_INTERVAL_MS || 300_000));
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    const child = spawn(process.execPath, [path.join(ROOT, 'import-wb.mjs'), '--no-images'], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', (e) => {
      running = false;
      log('Не удалось запустить синхронизацию WB:', e.message);
    });
    child.on('exit', (code) => {
      running = false;
      log(code === 0 ? 'Синхронизация WB завершена' : `Синхронизация WB завершилась с кодом ${code}`);
    });
  };
  setInterval(run, intervalMs);
  log(`Автосинхронизация WB включена: каждые ${Math.round(intervalMs / 60000)} мин.`);
}

server.listen(CFG.port, () => {
  log(`Магазин: http://localhost:${CFG.port}${CFG.dev ? '  (режим разработки)' : ''}`);
  startWildberriesSync();
  if (CFG.botToken) setupBot();
  else log('BOT_TOKEN не задан — бот и оплата выключены, работает только витрина');
});
