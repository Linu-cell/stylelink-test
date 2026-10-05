// Pure business logic. No browser APIs, no storage.
export const STAGES = ['New', 'Cutting', 'Sewing', 'Fitting', 'Alteration', 'Ready', 'Delivered'];
export const CONSTANTS = { dueSoonDays: 3, eventRiskDays: 7, staleCollectionDays: 7, backupWarnDays: 3 };

export class ValidationError extends Error {
  constructor(errors) { super(errors.join('; ')); this.name = 'ValidationError'; this.errors = errors; }
}

const pad = (n) => String(n).padStart(2, '0');
// Local calendar date from local parts (never from a UTC timestamp).
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
export const daysBetween = (a, b) => dayNum(b) - dayNum(a);
export function addDays(s, n) {
  const t = new Date((dayNum(s) + n) * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Returns +E.164 or null. Default country code Nigeria.
export function normalizePhone(raw, cc = '234') {
  if (!raw) return null;
  const s = String(raw).trim();
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (!plus) {
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.startsWith('0')) d = cc + d.slice(1);
    else if (d.length === 10) d = cc + d;
  }
  return d.length >= 8 && d.length <= 15 ? '+' + d : null;
}

export function financials(order, payments) {
  const live = payments.filter((p) => !p.voided_at);
  const paid = live.reduce((a, p) => a + (p.type === 'refund' ? -p.amount : p.amount), 0);
  const balance = order.total_price - paid;
  const status = balance < 0 ? 'Overpaid' : balance === 0 ? 'Paid' : paid <= 0 ? 'Unpaid' : 'Part-paid';
  return { paid, balance, status };
}

const done = (i) => i.status === 'Ready' || i.status === 'Delivered';
const liveItems = (items) => items.filter((i) => !i.deleted_at && i.status !== 'Cancelled');

export function orderSummary(allItems) {
  const items = liveItems(allItems);
  const n = items.length;
  if (!n) return 'Cancelled';
  const delivered = items.filter((i) => i.status === 'Delivered').length;
  if (delivered === n) return 'Delivered — all items delivered';
  const finished = items.filter(done).length;
  if (finished === n) return delivered > 0 ? `Ready — ${delivered} of ${n} delivered` : n === 1 ? 'Ready' : `Ready — all ${n} items`;
  const unfinished = items.filter((i) => !done(i));
  const idx = unfinished.map((i) => STAGES.indexOf(i.status));
  if (finished > 0) return `${STAGES[Math.min(...idx)]} — ${finished} of ${n} ready`;
  return [...new Set(idx)].sort((a, b) => a - b).map((i) => STAGES[i]).join(' / ');
}

// bundles: [{order, items, payments}]. Each order appears once in the primary sections.
export function todayBuckets(bundles, today, C = CONSTANTS) {
  const out = { overdue: [], eventAtRisk: [], dueSoon: [], awaitingCollection: [], balances: [], fittings: [] };
  const tomorrow = addDays(today, 1);
  const ORDER = ['overdue', 'eventAtRisk', 'dueSoon', 'awaitingCollection', 'balances'];
  for (const b of bundles) {
    const o = b.order;
    if (o.deleted_at || o.cancelled_at) continue;
    const items = liveItems(b.items);
    if (!items.length) continue;
    const unfinished = items.some((i) => !done(i));
    const fin = financials(o, b.payments);
    const f = {};
    if (unfinished && o.due_date < today) f.overdue = true;
    if (unfinished && o.event_date) { const d = daysBetween(today, o.event_date); if (d >= 0 && d <= C.eventRiskDays) f.eventAtRisk = true; }
    if (unfinished && o.due_date >= today && daysBetween(today, o.due_date) <= C.dueSoonDays) f.dueSoon = true;
    if (!unfinished && items.some((i) => i.status === 'Ready')) f.awaitingCollection = true;
    if (fin.balance > 0 && items.some(done)) f.balances = true;
    const primary = ORDER.find((k) => f[k]);
    if (primary) out[primary].push({ order: o, fin, summary: orderSummary(b.items), badges: ORDER.filter((k) => f[k] && k !== primary), daysLate: primary === 'overdue' ? daysBetween(o.due_date, today) : 0 });
    for (const i of items) if (!done(i) && (i.fitting_date === today || i.fitting_date === tomorrow)) out.fittings.push({ order: o, item: i });
  }
  const by = (k) => (a, b) => (a.order[k] < b.order[k] ? -1 : a.order[k] > b.order[k] ? 1 : 0);
  out.overdue.sort(by('due_date')); out.eventAtRisk.sort(by('event_date')); out.dueSoon.sort(by('due_date'));
  out.balances.sort((a, b) => b.fin.balance - a.fin.balance);
  return out;
}

export function validateOrderInput(inp) {
  const e = [];
  if (!inp.customer_id && !(inp.new_customer && inp.new_customer.full_name && inp.new_customer.full_name.trim())) e.push('Customer is required');
  if (!Array.isArray(inp.items) || !inp.items.length) e.push('At least one garment is required');
  else if (inp.items.some((i) => !i.garment_type || !String(i.garment_type).trim())) e.push('Every garment needs a type');
  if (!Number.isInteger(inp.total_price) || inp.total_price < 0) e.push('Price must be a whole number of naira, 0 or more');
  const dep = inp.deposit ?? 0;
  if (!Number.isInteger(dep) || dep < 0) e.push('Deposit must be a whole number of naira, 0 or more');
  if (!isDate(inp.due_date)) e.push('Due date is required (YYYY-MM-DD)');
  if (inp.event_date && !isDate(inp.event_date)) e.push('Event date is not a valid date');
  if (e.length) throw new ValidationError(e);
}

export function orderWarnings(inp, today) {
  const w = [];
  if (isDate(inp.due_date) && inp.due_date < today) w.push('Due date is in the past');
  if (isDate(inp.due_date) && isDate(inp.event_date)) {
    const m = daysBetween(inp.due_date, inp.event_date);
    if (m < 0) w.push('Ready after the event'); else if (m < 3) w.push('Less than 3 days before the event');
  }
  if ((inp.deposit ?? 0) > inp.total_price) w.push('Deposit is more than the price');
  return w;
}
