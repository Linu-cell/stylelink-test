// Read queries. Writes live in commands.js.
import { run, req } from './db.js';
const live = (r) => !r.deleted_at;
const group = (rows, k) => { const m = {}; for (const r of rows) (m[r[k]] ||= []).push(r); return m; };

export const getMeta = (db, key) => run(db, ['meta'], 'readonly', async (s) => { const r = await req(s.meta.get(key)); return r ? r.value : undefined; });
export const setMeta = (db, key, value) => run(db, ['meta'], 'readwrite', async (s) => { s.meta.put({ key, value }); });

export const latestSet = (list) => list.filter(live).sort((a, b) => b.seq - a.seq)[0] || null;
export const currentMeasurementSet = (db, customerId) => run(db, ['measurement_sets'], 'readonly', async (s) => latestSet(await req(s.measurement_sets.index('by_customer').getAll(customerId))));
export const listCustomers = (db) => run(db, ['customers'], 'readonly', async (s) => (await req(s.customers.getAll())).filter(live).sort((a, b) => a.full_name_lc.localeCompare(b.full_name_lc)));

export const listBundles = (db) => run(db, ['orders', 'customers', 'order_items', 'payments'], 'readonly', async (s) => {
  const orders = (await req(s.orders.getAll())).filter(live);
  const cm = Object.fromEntries((await req(s.customers.getAll())).map((c) => [c.id, c]));
  const im = group(await req(s.order_items.getAll()), 'order_id');
  const pm = group(await req(s.payments.getAll()), 'order_id');
  return orders.map((o) => ({ order: o, customer: cm[o.customer_id], items: im[o.id] || [], payments: pm[o.id] || [] }));
});

export const getBundle = (db, orderId) => run(db, ['orders', 'customers', 'order_items', 'payments', 'status_events'], 'readonly', async (s) => {
  const order = await req(s.orders.get(orderId));
  if (!order) return null;
  const items = await req(s.order_items.index('by_order').getAll(orderId));
  const events = [];
  for (const i of items) events.push(...(await req(s.status_events.index('by_item').getAll(i.id))));
  return { order, customer: await req(s.customers.get(order.customer_id)), items, payments: await req(s.payments.index('by_order').getAll(orderId)), events };
});
