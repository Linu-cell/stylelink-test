// Every business write is ONE atomic transaction (all rows saved, or none).
import { run, req } from './db.js';
import { STAGES, normalizePhone, validateOrderInput, localDate, financials, ValidationError } from './domain.js';
import { latestSet } from './repo.js';

export class OverpaymentError extends Error { constructor(over) { super(`This would overpay by ${over}`); this.name = 'OverpaymentError'; this.over = over; } }
export class BackwardMoveError extends Error { constructor(a, b) { super(`Moving back from ${a} to ${b} needs confirmation`); this.name = 'BackwardMoveError'; } }

const stamp = (ctx, row, t) => ({ ...row, workspace_id: ctx.workspaceId, created_at: t, updated_at: t, created_by: ctx.userId, deleted_at: null, version: 1 });
const touch = (row, t) => ({ ...row, updated_at: t, version: (row.version || 0) + 1 });
const fail = (m) => { throw new Error(m); };

// Creates the single workspace + owner on first run. Call again after a restore.
export async function getContext(db, { now = () => new Date().toISOString(), idGen = () => crypto.randomUUID(), hook = null } = {}) {
  const ids = await run(db, ['meta', 'workspaces', 'users'], 'readwrite', async (s) => {
    const w = await req(s.meta.get('workspace_id')); const u = await req(s.meta.get('user_id'));
    if (w && u) return { workspaceId: w.value, userId: u.value };
    const wid = idGen(); const uid = idGen(); const t = now();
    s.workspaces.put({ id: wid, workspace_id: wid, name: 'Stylelink', currency: 'NGN', timezone: 'Africa/Lagos', settings: {}, created_at: t, updated_at: t, created_by: uid, deleted_at: null, version: 1 });
    s.users.put({ id: uid, workspace_id: wid, name: 'Owner', role: 'owner', created_at: t, updated_at: t, created_by: uid, deleted_at: null, version: 1 });
    s.meta.put({ key: 'workspace_id', value: wid }); s.meta.put({ key: 'user_id', value: uid }); s.meta.put({ key: 'order_counter', value: 0 });
    return { workspaceId: wid, userId: uid };
  });
  return { ...ids, now, idGen, hook };
}

const customerRow = (ctx, c, t) => {
  if (!c || !c.full_name || !c.full_name.trim()) throw new ValidationError(['Customer name is required']);
  const name = c.full_name.trim();
  return stamp(ctx, { id: ctx.idGen(), full_name: name, full_name_lc: name.toLowerCase(), phone: c.phone || null, phone_norm: normalizePhone(c.phone), notes: c.notes || '' }, t);
};
export const createCustomer = (db, ctx, c) => { const row = customerRow(ctx, c, ctx.now()); return run(db, ['customers'], 'readwrite', async (s) => { s.customers.put(row); return row; }); };

// Measurement sets are append-only: there is no update function by design.
export async function saveMeasurementSet(db, ctx, m) {
  const e = [];
  const vals = m.values || {};
  if (!m.customer_id) e.push('Customer is required');
  if (!Object.keys(vals).length) e.push('Enter at least one measurement');
  for (const [k, v] of Object.entries(vals)) if (typeof v !== 'number' || !(v > 0)) e.push(`${k} must be a positive number`);
  if (!['in', 'cm'].includes(m.unit)) e.push('Unit must be in or cm');
  if (e.length) throw new ValidationError(e);
  const t = ctx.now();
  return run(db, ['measurement_sets', 'customers'], 'readwrite', async (s) => {
    if (!(await req(s.customers.get(m.customer_id)))) fail('Customer not found');
    const prior = await req(s.measurement_sets.index('by_customer').getAll(m.customer_id));
    const row = stamp(ctx, { id: ctx.idGen(), customer_id: m.customer_id, taken_on: m.taken_on || localDate(), unit: m.unit, values: { ...vals }, notes: m.notes || '', seq: prior.length + 1 }, t);
    s.measurement_sets.put(row);
    return row;
  });
}

export async function createOrder(db, ctx, input) {
  validateOrderInput(input);
  const deposit = input.deposit ?? 0;
  if (deposit > input.total_price && !input.allow_overpay) throw new OverpaymentError(deposit - input.total_price);
  const t = ctx.now(); const today = localDate();
  return run(db, ['customers', 'measurement_sets', 'orders', 'order_items', 'payments', 'status_events', 'meta'], 'readwrite', async (s) => {
    let customer; let customerId = input.customer_id;
    if (customerId) { customer = await req(s.customers.get(customerId)); if (!customer || customer.deleted_at) fail('Customer not found'); }
    else { customer = customerRow(ctx, input.new_customer, t); customerId = customer.id; s.customers.put(customer); }
    const defaultSet = input.customer_id ? latestSet(await req(s.measurement_sets.index('by_customer').getAll(customerId))) : null;
    const counter = ((await req(s.meta.get('order_counter'))) || { value: 0 }).value + 1;
    s.meta.put({ key: 'order_counter', value: counter });
    const order = stamp(ctx, { id: ctx.idGen(), customer_id: customerId, order_no: 'SL-' + String(counter).padStart(4, '0'), order_date: input.order_date || today, event_date: input.event_date || null, due_date: input.due_date, total_price: input.total_price, notes: input.notes || '', cancelled_at: null, cancel_reason: null, last_messaged_at: null, last_message_type: null }, t);
    s.orders.put(order);
    const items = [];
    for (const it of input.items) {
      let setId = it.measurement_set_id || (defaultSet && defaultSet.id) || null;
      if (setId) { const ms = await req(s.measurement_sets.get(setId)); if (!ms || ms.customer_id !== customerId) fail('Measurement set does not belong to this customer'); }
      const item = stamp(ctx, { id: ctx.idGen(), order_id: order.id, garment_type: it.garment_type.trim(), quantity: it.quantity || 1, fabric: it.fabric || '', style_notes: it.style_notes || '', measurement_set_id: setId, status: 'New', fitting_date: it.fitting_date || null, ready_at: null, delivered_at: null }, t);
      s.order_items.put(item); items.push(item);
      s.status_events.put(stamp(ctx, { id: ctx.idGen(), order_item_id: item.id, seq: 1, from_status: null, to_status: 'New', changed_at: t, changed_by: ctx.userId, note: null }, t));
    }
    const payments = [];
    if (deposit > 0) { const p = stamp(ctx, { id: ctx.idGen(), order_id: order.id, amount: deposit, paid_on: input.order_date || today, type: 'payment', note: 'Deposit', voided_at: null, void_reason: null }, t); s.payments.put(p); payments.push(p); }
    if (ctx.hook) ctx.hook('createOrder:after-writes'); // test-only failure injection point
    return { order, customer, items, payments };
  });
}

export function addPayment(db, ctx, p) {
  const t = ctx.now();
  return run(db, ['orders', 'payments'], 'readwrite', async (s) => {
    if (!Number.isInteger(p.amount) || p.amount <= 0) throw new ValidationError(['Amount must be a whole number of naira above 0']);
    const order = await req(s.orders.get(p.order_id));
    if (!order || order.cancelled_at) fail('Order not found or cancelled');
    const type = p.type || 'payment';
    const pays = await req(s.payments.index('by_order').getAll(p.order_id));
    const before = financials(order, pays);
    if (type === 'refund' && p.amount > before.paid) fail('Refund is more than has been paid');
    const after = type === 'refund' ? before.balance + p.amount : before.balance - p.amount;
    if (after < 0 && !p.allow_overpay) throw new OverpaymentError(-after);
    const row = stamp(ctx, { id: ctx.idGen(), order_id: p.order_id, amount: p.amount, paid_on: p.paid_on || localDate(), type, note: p.note || '', voided_at: null, void_reason: null }, t);
    s.payments.put(row);
    return { payment: row, balance: after };
  });
}

export function voidPayment(db, ctx, paymentId, reason) {
  const t = ctx.now();
  return run(db, ['payments'], 'readwrite', async (s) => {
    const p = await req(s.payments.get(paymentId));
    if (!p) fail('Payment not found');
    if (p.voided_at) fail('Payment already voided');
    const upd = touch({ ...p, voided_at: t, void_reason: reason || 'Corrected' }, t);
    s.payments.put(upd);
    return upd;
  });
}

async function applyStatus(s, ctx, itemId, to, { note = null, confirmBack = false } = {}) {
  const item = await req(s.order_items.get(itemId));
  if (!item) fail('Item not found');
  const order = await req(s.orders.get(item.order_id));
  if (order.cancelled_at || item.status === 'Cancelled') fail('Order or item is cancelled');
  const from = STAGES.indexOf(item.status); const toI = STAGES.indexOf(to);
  if (toI < 0) fail(`Unknown stage ${to}`);
  if (toI === from) fail('Already at that stage');
  if (toI < from && !confirmBack) throw new BackwardMoveError(item.status, to);
  const t = ctx.now(); const readyI = STAGES.indexOf('Ready');
  const upd = touch({ ...item, status: to }, t);
  upd.ready_at = toI < readyI ? null : to === 'Ready' ? t : item.ready_at || t;
  upd.delivered_at = to === 'Delivered' ? t : null;
  s.order_items.put(upd);
  const prior = await req(s.status_events.index('by_item').getAll(itemId));
  s.status_events.put(stamp(ctx, { id: ctx.idGen(), order_item_id: itemId, seq: prior.length + 1, from_status: item.status, to_status: to, changed_at: t, changed_by: ctx.userId, note }, t));
  return upd;
}
export const changeItemStatus = (db, ctx, itemId, to, opts) => run(db, ['order_items', 'orders', 'status_events'], 'readwrite', (s) => applyStatus(s, ctx, itemId, to, opts));
export const undoLastStatus = (db, ctx, itemId) => run(db, ['order_items', 'orders', 'status_events'], 'readwrite', async (s) => {
  const ev = (await req(s.status_events.index('by_item').getAll(itemId))).sort((a, b) => b.seq - a.seq)[0];
  if (!ev || !ev.from_status) fail('Nothing to undo');
  return applyStatus(s, ctx, itemId, ev.from_status, { confirmBack: true, note: 'undo' });
});

export function relinkMeasurement(db, ctx, itemId, setId, note) {
  const t = ctx.now();
  return run(db, ['order_items', 'orders', 'measurement_sets', 'status_events'], 'readwrite', async (s) => {
    const item = await req(s.order_items.get(itemId)); const order = await req(s.orders.get(item.order_id)); const ms = await req(s.measurement_sets.get(setId));
    if (!ms || ms.customer_id !== order.customer_id) fail('Measurement set does not belong to this customer');
    const upd = touch({ ...item, measurement_set_id: setId }, t);
    s.order_items.put(upd);
    const prior = await req(s.status_events.index('by_item').getAll(itemId));
    s.status_events.put(stamp(ctx, { id: ctx.idGen(), order_item_id: itemId, seq: prior.length + 1, from_status: item.status, to_status: item.status, changed_at: t, changed_by: ctx.userId, note: note || 'Measurements re-linked' }, t));
    return upd;
  });
}

// resolution: {type:'refund'} (refunds everything paid) | {type:'forfeit', note}
export function cancelOrder(db, ctx, orderId, { reason, resolution } = {}) {
  const t = ctx.now();
  return run(db, ['orders', 'order_items', 'payments', 'status_events'], 'readwrite', async (s) => {
    const order = await req(s.orders.get(orderId));
    if (!order || order.cancelled_at) fail('Order not found or already cancelled');
    const items = await req(s.order_items.index('by_order').getAll(orderId));
    if (items.some((i) => i.status === 'Delivered')) fail('Cannot cancel an order with delivered items');
    const paid = financials(order, await req(s.payments.index('by_order').getAll(orderId))).paid;
    if (paid > 0 && !resolution) fail('Payments must be resolved: refund or forfeit the deposit');
    if (paid > 0 && resolution.type === 'refund') s.payments.put(stamp(ctx, { id: ctx.idGen(), order_id: orderId, amount: paid, paid_on: localDate(), type: 'refund', note: 'Refund on cancellation', voided_at: null, void_reason: null }, t));
    s.orders.put(touch({ ...order, cancelled_at: t, cancel_reason: reason || (resolution && resolution.note) || 'Cancelled' }, t));
    for (const i of items) {
      s.order_items.put(touch({ ...i, status: 'Cancelled', ready_at: null, delivered_at: null }, t));
      const prior = await req(s.status_events.index('by_item').getAll(i.id));
      s.status_events.put(stamp(ctx, { id: ctx.idGen(), order_item_id: i.id, seq: prior.length + 1, from_status: i.status, to_status: 'Cancelled', changed_at: t, changed_by: ctx.userId, note: reason || null }, t));
    }
    return { cancelled: orderId };
  });
}

export function markMessaged(db, ctx, orderId, type) {
  const t = ctx.now();
  return run(db, ['orders'], 'readwrite', async (s) => {
    const o = await req(s.orders.get(orderId));
    if (!o) fail('Order not found');
    s.orders.put(touch({ ...o, last_messaged_at: t, last_message_type: type }, t));
  });
}
