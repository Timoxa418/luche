// Серверный клиент Supabase через REST API. Секретный ключ используется только на сервере.
function config() {
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
}
export function supabaseReady() { const c = config(); return Boolean(c.url && c.key); }

export async function dbRequest(table, { method = 'GET', query = '', body, prefer = 'return=representation' } = {}) {
  const { url, key } = config();
  if (!url || !key) throw new Error('Не заданы SUPABASE_URL и SUPABASE_SECRET_KEY в Railway Variables');
  const response = await fetch(`${url}/rest/v1/${table}${query ? `?${query}` : ''}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    const message = data?.message || data?.hint || data?.details || raw || response.statusText;
    throw new Error(`Supabase ${table} ${response.status}: ${message}`);
  }
  return data;
}

export async function getCatalog() {
  const [products, variants, stocks] = await Promise.all([
    dbRequest('products', { query: 'select=id,wb_nm_id,name,description,brand,category,attributes,images,image_url,price,old_price,is_active&is_active=eq.true&order=name.asc' }),
    dbRequest('variants', { query: 'select=id,product_id,wb_chrt_id,sku,size,price&order=size.asc' }),
    dbRequest('stocks', { query: 'select=variant_id,warehouse,quantity' }),
  ]);
  const stockByVariant = new Map();
  for (const row of stocks || []) {
    const entry = stockByVariant.get(row.variant_id) || { quantity: 0, warehouses: [] };
    entry.quantity += Number(row.quantity) || 0;
    entry.warehouses.push({ name: row.warehouse, quantity: Number(row.quantity) || 0 });
    stockByVariant.set(row.variant_id, entry);
  }
  return {
    currency: 'RUB',
    updatedAt: new Date().toISOString(),
    products: (products || []).map((p) => {
      const pv = (variants || []).filter((v) => v.product_id === p.id);
      const sizes = pv.map((v) => {
        const st = stockByVariant.get(v.id) || { quantity: 0, warehouses: [] };
        return {
          id: v.id,
          chrtId: v.wb_chrt_id,
          size: v.size,
          sku: v.sku || '',
          price: Number(v.price) > 0 ? Number(v.price) : Number(p.price) || 0,
          stock: st.quantity,
          warehouses: st.warehouses,
          available: st.quantity > 0,
        };
      });
      return {
        id: String(p.wb_nm_id || p.id),
        dbId: p.id,
        sku: pv[0]?.sku || '',
        title: p.name,
        brand: p.brand || '',
        category: p.category || 'Другое',
        description: p.description || '',
        price: Number(p.price) || 0,
        oldPrice: Number(p.old_price) || 0,
        images: Array.isArray(p.images) && p.images.length ? p.images : (p.image_url ? [p.image_url] : []),
        sizes,
        attrs: Array.isArray(p.attributes) ? p.attributes : [],
      };
    }),
  };
}

export async function saveOrder(order, customer = {}) {
  const [saved] = await dbRequest('orders', {
    method: 'POST',
    query: 'select=id',
    body: {
      telegram_user_id: order.user?.id || null,
      customer_name: customer.name || order.user?.name || null,
      phone: customer.phone_number || null,
      status: order.status || 'new',
      total: order.total,
      comment: order.comment || null,
    },
  });
  const rows = order.lines.map((line) => ({
    order_id: saved.id,
    variant_id: line.variantId || null,
    product_name: line.title,
    size: line.size,
    quantity: line.qty,
    price: line.price,
  }));
  if (rows.length) await dbRequest('order_items', { method: 'POST', body: rows, prefer: 'return=minimal' });
  return saved.id;
}

export async function setOrderStatus(id, status, customer = {}) {
  const patch = { status };
  if (customer.name) patch.customer_name = customer.name;
  if (customer.phone_number) patch.phone = customer.phone_number;
  await dbRequest('orders', {
    method: 'PATCH',
    query: `id=eq.${encodeURIComponent(id)}`,
    body: patch,
    prefer: 'return=minimal',
  });
}

export async function getOrder(id) {
  const orders = await dbRequest('orders', { query: `select=id,telegram_user_id,customer_name,phone,status,total,comment,created_at&id=eq.${encodeURIComponent(id)}&limit=1` });
  const order = orders?.[0];
  if (!order) return null;
  const items = await dbRequest('order_items', { query: `select=variant_id,product_name,size,quantity,price&order_id=eq.${encodeURIComponent(id)}` });
  return {
    id: order.id, status: order.status, total: Number(order.total) || 0,
    user: order.telegram_user_id ? { id: order.telegram_user_id, name: order.customer_name || '' } : null,
    lines: (items || []).map((x) => ({ variantId: x.variant_id, title: x.product_name, size: x.size || '', qty: Number(x.quantity), price: Number(x.price) })),
    shipping: 0,
  };
}
