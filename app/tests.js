// Stylelink Orders Step 1 test runner v3 (corrected). Imports come from the same folder.
import { openDb, run, req, dumpTx, deleteDb, MIGRATIONS, DATA_STORES, SchemaTooNewError } from './db.js';
import * as C from './commands.js';
import * as R from './repo.js';
import * as D from './domain.js';
import * as B from './backup.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const names = [];
let seq = 0;
const eq = (a, b, m) => { if (B.canon(a) !== B.canon(b)) throw new Error(`${m || 'not equal'}: got ${B.canon(a).slice(0, 160)} expected ${B.canon(b).slice(0, 160)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const rejects = async (p, name, m) => { try { await p; } catch (e) { if (name && e.name !== name) throw new Error(`${m || ''} expected ${name} but got ${e.name}: ${e.message}`); return e; } throw new Error(`${m || 'expected rejection'}: it succeeded`); };

const opened = [];
async function fresh(opts) { const n = `sl-test-${Date.now()}-${seq++}`; names.push(n); const db = await openDb(n, opts); opened.push(db); return { name: n, db }; }
function clock() { let t = 0; return () => new Date(Date.UTC(2026, 9, 4, 8, 0, t++)).toISOString(); }
const mkCtx = (db, extra) => C.getContext(db, { now: clock(), ...extra });
const dump = (db) => run(db, [...DATA_STORES, 'meta'], 'readonly', (s) => dumpTx(s));
const counts = (db) => run(db, [...DATA_STORES, 'meta'], 'readonly', async (s) => { const o = {}; for (const n of DATA_STORES) o[n] = (await req(s[n].getAll())).length; o.counter = ((await req(s.meta.get('order_counter'))) || {}).value; return o; });
const tot = (c) => Object.values(c).reduce((a, b) => a + (b || 0), 0);
const S = (c) => DATA_STORES.map((n) => `${n}:${c[n]}`).join(' ');

async function seed(db, ctx, tag = 'A') {
  const cust = await C.createCustomer(db, ctx, { full_name: `Customer ${tag}1`, phone: '08031234567' });
  const ms1 = await C.saveMeasurementSet(db, ctx, { customer_id: cust.id, unit: 'in', values: { chest: 40, waist: 34 } });
  const ms2 = await C.saveMeasurementSet(db, ctx, { customer_id: cust.id, unit: 'in', values: { chest: 41, waist: 35 } });
  const o1 = await C.createOrder(db, ctx, { customer_id: cust.id, items: [{ garment_type: 'Agbada' }, { garment_type: 'Trouser' }], total_price: 120000, deposit: 50000, due_date: '2026-10-20', event_date: '2026-10-25' });
  const p2 = await C.addPayment(db, ctx, { order_id: o1.order.id, amount: 5000 });
  await C.voidPayment(db, ctx, p2.payment.id, 'wrong amount');
  await C.addPayment(db, ctx, { order_id: o1.order.id, amount: 30000 });
  await C.changeItemStatus(db, ctx, o1.items[0].id, 'Cutting');
  await C.changeItemStatus(db, ctx, o1.items[0].id, 'Sewing');
  await C.changeItemStatus(db, ctx, o1.items[0].id, 'Ready');
  const o2 = await C.createOrder(db, ctx, { new_customer: { full_name: `Customer ${tag}2` }, items: [{ garment_type: 'Shirt' }], total_price: 40000, deposit: 0, due_date: '2026-10-12' });
  return { cust, ms1, ms2, o1, o2 };
}

/* ---------------- Step 1 required tests ---------------- */
test('01 Atomic multi-table save', async (t) => {
  const { db } = await fresh(); const ctx = await mkCtx(db);
  const before = await counts(db);
  const r = await C.createOrder(db, ctx, { new_customer: { full_name: 'Ada Obi', phone: '0803 123 4567' }, items: [{ garment_type: 'Agbada' }, { garment_type: 'Trouser' }], total_price: 100000, deposit: 40000, due_date: '2026-10-20' });
  const after = await counts(db);
  t.log('before: ' + S(before) + ' counter:' + before.counter);
  t.log('after:  ' + S(after) + ' counter:' + after.counter);
  eq([after.customers, after.orders, after.order_items, after.payments, after.status_events, after.counter], [1, 1, 2, 1, 2, 1], 'one order wrote to all tables');
  eq(r.order.order_no, 'SL-0001'); eq(r.customer.phone_norm, '+2348031234567');
  const b = await R.getBundle(db, r.order.id);
  eq(D.financials(b.order, b.payments), { paid: 40000, balance: 60000, status: 'Part-paid' });
  t.log(`order ${r.order.order_no}, balance ${D.financials(b.order, b.payments).balance}, summary "${D.orderSummary(b.items)}"`);
});

test('02a Forced failure mid-write leaves NO partial order', async (t) => {
  const { db } = await fresh(); const ctx = await mkCtx(db);
  await C.createOrder(db, ctx, { new_customer: { full_name: 'Existing' }, items: [{ garment_type: 'Shirt' }], total_price: 10000, due_date: '2026-10-20' });
  const before = await counts(db); const dumpBefore = await dump(db);
  const failing = { ...ctx, hook: () => { throw new Error('forced failure after all writes were issued'); } };
  const e = await rejects(C.createOrder(db, failing, { new_customer: { full_name: 'Will Fail' }, items: [{ garment_type: 'Agbada' }, { garment_type: 'Cap' }], total_price: 90000, deposit: 20000, due_date: '2026-10-21' }), 'Error');
  const after = await counts(db);
  t.log('error: ' + e.message);
  t.log('before: ' + S(before) + ' counter:' + before.counter);
  t.log('after:  ' + S(after) + ' counter:' + after.counter);
  eq(await dump(db), dumpBefore, 'database identical after failed save');
  const next = await C.createOrder(db, ctx, { new_customer: { full_name: 'Next' }, items: [{ garment_type: 'Shirt' }], total_price: 1000, due_date: '2026-10-22' });
  eq(next.order.order_no, 'SL-0002', 'no order-number gap after the failed save');
  t.log('next order number is ' + next.order.order_no + ' (no gap)');
});

test('02b A real IndexedDB error mid-transaction also rolls everything back', async (t) => {
  const { db } = await fresh(); const ctx = await mkCtx(db);
  const o = await C.createOrder(db, ctx, { new_customer: { full_name: 'Existing' }, items: [{ garment_type: 'Shirt' }], total_price: 10000, due_date: '2026-10-20' });
  const before = await dump(db);
  const e = await rejects(run(db, ['customers', 'orders'], 'readwrite', async (s) => {
    s.customers.put({ id: 'x1', full_name: 'Ghost', full_name_lc: 'ghost', phone_norm: null });
    await req(s.orders.add({ ...o.order })); // duplicate key -> ConstraintError
  }));
  t.log('IndexedDB error: ' + e.name);
  eq(await dump(db), before, 'ghost customer was rolled back');
});

test('02c Validation errors write nothing', async (t) => {
  const { db } = await fresh(); const ctx = await mkCtx(db); const before = await counts(db);
  const e = await rejects(C.createOrder(db, ctx, { items: [], total_price: -5, due_date: 'nope' }), 'ValidationError');
  t.log(e.errors.join(' | '));
  eq(await counts(db), before);
  await rejects(C.createOrder(db, ctx, { new_customer: { full_name: 'X' }, items: [{ garment_type: 'A' }], total_price: 100, deposit: 500, due_date: '2026-10-20' }), 'OverpaymentError');
  eq(await counts(db), before, 'overpaid deposit not saved without confirmation');
});

test('02d Guard rail: a non-database await inside a transaction is reported, not hidden', async (t) => {
  const { db } = await fresh();
  const e = await rejects(run(db, ['customers'], 'readwrite', async (s) => {
    s.customers.put({ id: 'early', full_name: 'Early', full_name_lc: 'early', phone_norm: null });
    await new Promise((r) => setTimeout(r, 30)); // forbidden: browser auto-commits here
    s.customers.put({ id: 'late', full_name: 'Late', full_name_lc: 'late', phone_norm: null });
  }));
  const got = await run(db, ['customers'], 'readonly', async (s) => (await req(s.customers.getAll())).map((c) => c.id));
  t.log(`caller received ${e.name}; rows that persisted: [${got}]`);
  t.log('This is why the code rule exists: that early write DID commit. The error is at least surfaced to the caller.');
  ok(e.name === 'TransactionInactiveError');
});

test('03 Backup export round trip', async (t) => {
  const a = await fresh(); const ctx = await mkCtx(a.db); await seed(a.db, ctx);
  const original = await dump(a.db);
  const file = B.serializeBackup(await B.buildBackup(a.db));
  t.log(`file ${B.backupFileName(new Date(2026, 9, 4, 14, 5))}, ${file.length} bytes`);
  const v = await B.validateBackupText(file); ok(v.ok, v.errors.join());
  const b = await fresh(); await B.restoreBackup(b.db, v);
  eq(await dump(b.db), original, 'restored data identical');
  t.log('restored counts: ' + S(await counts(b.db)));
  const again = await B.buildBackup(b.db);
  eq(again.checksum, JSON.parse(file).checksum, 'checksum of restored data equals original');
  t.log('checksum matches after round trip: ' + again.checksum.slice(0, 16) + '…');
  const c2 = await C.getContext(b.db, { now: clock() });
  const n = await C.createOrder(b.db, c2, { new_customer: { full_name: 'Post-restore' }, items: [{ garment_type: 'Cap' }], total_price: 100, due_date: '2026-10-30' });
  eq(n.order.order_no, 'SL-0003', 'order numbering continues after restore');
});

test('04 Corrupt backups are rejected (and nothing is written)', async (t) => {
  const a = await fresh(); const ctx = await mkCtx(a.db); await seed(a.db, ctx);
  const good = await B.buildBackup(a.db); const text = B.serializeBackup(good);
  const clone = () => JSON.parse(text);
  const resign = async (o) => { o.checksum = await B.sha256(B.canon(o.data)); return o; };
  const cases = {
    'tampered amount': () => { const o = clone(); o.data.payments[0].amount += 1; return o; },
    'truncated file': () => text.slice(0, Math.floor(text.length / 2)),
    'wrong format': () => ({ ...clone(), format: 'something-else' }),
    'missing table (valid checksum)': async () => { const o = clone(); delete o.data.orders; return resign(o); },
    'dangling reference (valid checksum)': async () => { const o = clone(); o.data.customers = []; o.counts.customers = 0; return resign(o); },
    'counts disagree': () => { const o = clone(); o.counts.orders = 99; return o; },
  };
  const sink = await fresh(); const sinkBefore = await dump(sink.db);
  for (const [name, mk] of Object.entries(cases)) {
    const input = await mk();
    const v = typeof input === 'string' ? await B.validateBackupText(input) : await B.validateBackup(input);
    ok(!v.ok, `${name} was accepted`);
    await rejects(B.restoreBackup(sink.db, v), null, 'restore must refuse unvalidated file');
    t.log(`${name}: REJECTED, ${v.errors[0]}`);
  }
  eq(await dump(sink.db), sinkBefore, 'database untouched by all rejected files');
});

async function scenario() {
  const A = await fresh(); const ctxA = await mkCtx(A.db); await seed(A.db, ctxA, 'A');
  const Bd = await fresh(); const ctxB = await mkCtx(Bd.db); await seed(Bd.db, ctxB, 'B'); await C.createOrder(Bd.db, ctxB, { new_customer: { full_name: 'Extra B' }, items: [{ garment_type: 'Cap' }], total_price: 5000, due_date: '2026-11-01' });
  const dumpA = await dump(A.db); const dumpB = await dump(Bd.db);
  const v = await B.validateBackup(await B.buildBackup(Bd.db));
  return { A, dumpA, dumpB, v };
}

test('05 Restore replaces data completely (no merge)', async (t) => {
  const { A, dumpA, dumpB, v } = await scenario();
  t.log('before restore: ' + S(await counts(A.db)));
  await B.restoreBackup(A.db, v);
  const now = await dump(A.db);
  eq(now, dumpB, 'database equals the backup exactly');
  const leftovers = dumpA.customers.filter((c) => now.customers.some((x) => x.id === c.id));
  eq(leftovers.length, 0, 'no old records remain');
  t.log('after restore:  ' + S(await counts(A.db)) + ' (old customers remaining: 0)');
});

test('06 Automatic pre-restore snapshot', async (t) => {
  const { A, dumpA, v } = await scenario();
  ok(!(await B.hasSnapshot(A.db, 'pre-restore')), 'no snapshot before restore');
  await B.restoreBackup(A.db, v);
  ok(await B.hasSnapshot(A.db, 'pre-restore'), 'snapshot exists');
  const snap = await run(A.db, ['snapshots'], 'readonly', (s) => req(s.snapshots.get('pre-restore')));
  eq(snap.data, dumpA, 'snapshot holds the pre-restore data');
  t.log(`snapshot saved ${snap.created_at}, schema ${snap.schema_version}, ${snap.data.orders.length} orders`);
  // A restore that fails part-way must leave NO snapshot and NO changes (single transaction).
  const f = await scenario(); const beforeFail = await dump(f.A.db);
  const broken = { ok: true, data: { ...f.v.data, customers: [{ not_an_id: true }] } }; // row with no key -> fails mid-restore
  await rejects(B.restoreBackup(f.A.db, broken));
  eq(await dump(f.A.db), beforeFail, 'failed restore changed nothing');
  ok(!(await B.hasSnapshot(f.A.db, 'pre-restore')), 'failed restore left no snapshot behind');
  t.log('a restore that fails mid-way rolled back completely: data unchanged, no snapshot');
});

test('07 Undo last restore', async (t) => {
  const { A, dumpA, v } = await scenario();
  await B.restoreBackup(A.db, v);
  const c = await B.undoLastRestore(A.db);
  eq(await dump(A.db), dumpA, 'original data fully back');
  ok(!(await B.hasSnapshot(A.db, 'pre-restore')), 'snapshot consumed');
  await rejects(B.undoLastRestore(A.db), null, 'second undo');
  t.log('undo restored ' + S(c) + '; a second undo is refused');
});

const V2 = [...MIGRATIONS, { to: 2, upgrade(db, tx) { tx.objectStore('customers').createIndex('by_tag', 'tag'); }, transform: (n, r) => (n === 'customers' ? { ...r, tag: 'migrated' } : r) }];

test('08a Dummy migration v1 -> v2 (structure, rows, snapshot)', async (t) => {
  const { name, db } = await fresh(); const ctx = await mkCtx(db); await seed(db, ctx);
  const v1 = await dump(db); db.close();
  const db2 = await openDb(name, { schemaVersion: 2, migrations: V2 });
  eq(db2.version, 2);
  const idx = db2.transaction('customers').objectStore('customers').indexNames.contains('by_tag');
  const now = await dump(db2);
  ok(idx, 'new index exists');
  ok(now.customers.every((c) => c.tag === 'migrated'), 'all customer rows transformed');
  eq(now.customers.map(({ tag, ...r }) => r), v1.customers, 'other customer fields untouched');
  for (const n of DATA_STORES.filter((x) => x !== 'customers')) eq(now[n], v1[n], n + ' unchanged');
  const snap = await run(db2, ['snapshots'], 'readonly', (s) => req(s.snapshots.get('pre-migration')));
  ok(snap && snap.schema_version === 1, 'pre-migration snapshot exists'); eq(snap.data, v1, 'snapshot = v1 data');
  t.log(`upgraded to v${db2.version}; ${now.customers.length} customers got tag; index by_tag present; pre-migration snapshot (v${snap.schema_version}) saved`);
  const f = await fresh({ schemaVersion: 2, migrations: V2 });
  ok(f.db.transaction('customers').objectStore('customers').indexNames.contains('by_tag'), 'fresh v2 install has index');
  t.log('fresh install straight to v2 also correct');
});

test('08b A failing migration rolls back and leaves v1 data intact', async (t) => {
  const { name, db } = await fresh(); const ctx = await mkCtx(db); await seed(db, ctx);
  const v1 = await dump(db); db.close();
  const BAD = [...MIGRATIONS, { to: 2, upgrade(d, tx) { tx.objectStore('customers').createIndex('by_tag', 'tag'); }, transform: () => { throw new Error('boom'); } }];
  const e = await rejects(openDb(name, { schemaVersion: 2, migrations: BAD }));
  t.log('upgrade failed with: ' + e.name);
  const back = await openDb(name);
  eq(back.version, 1, 'still version 1');
  eq(await dump(back), v1, 'data intact');
  ok(!back.transaction('customers').objectStore('customers').indexNames.contains('by_tag'), 'no half-applied structure');
  t.log('database still v1, data identical, no half-applied index');
});

test('09 Older-schema backup migrates forward on restore', async (t) => {
  const old = await fresh(); const ctxO = await mkCtx(old.db); await seed(old.db, ctxO);
  const v1File = await B.buildBackup(old.db); // schema 1 file
  ok(v1File.schema_version === 1);
  const v = await B.validateBackup(v1File, { schemaVersion: 2, migrations: V2 });
  ok(v.ok && v.needsMigration, v.errors.join());
  const target = await fresh({ schemaVersion: 2, migrations: V2 });
  await B.restoreBackup(target.db, v, { schemaVersion: 2 });
  const now = await dump(target.db);
  ok(now.customers.length > 0 && now.customers.every((c) => c.tag === 'migrated'), 'restored rows carry the v2 field');
  eq(now.orders, (await dump(old.db)).orders, 'orders identical');
  t.log(`v1 backup (${S(v.summary.counts)}) restored into v2 app; customers migrated`);
});

test('10 Newer-schema backup is rejected', async (t) => {
  const a = await fresh(); const ctx = await mkCtx(a.db); await seed(a.db, ctx);
  const f = await B.buildBackup(a.db, { schemaVersion: 3 }); // a file from a future app
  const v = await B.validateBackup(f, { schemaVersion: 2, migrations: V2 });
  ok(!v.ok); t.log('rejected: ' + v.errors[0]);
  const before = await dump(a.db);
  await rejects(B.restoreBackup(a.db, v), null);
  eq(await dump(a.db), before, 'database unchanged');
  // Stored data newer than the app: openDb must refuse.
  const { name, db } = await fresh({ schemaVersion: 2, migrations: V2 }); db.close();
  const e = await rejects(openDb(name, { schemaVersion: 1 }), 'SchemaTooNewError');
  t.log('old app against newer database: ' + e.message);
});

/* ---------------- Supporting tests ---------------- */
test('11 Measurements are immutable; each item keeps its set', async (t) => {
  const { db } = await fresh(); const ctx = await mkCtx(db);
  const c = await C.createCustomer(db, ctx, { full_name: 'Mura' });
  const s1 = await C.saveMeasurementSet(db, ctx, { customer_id: c.id, unit: 'in', values: { waist: 34 } });
  const o1 = await C.createOrder(db, ctx, { customer_id: c.id, items: [{ garment_type: 'Trouser' }], total_price: 1000, due_date: '2026-10-20' });
  const s2 = await C.saveMeasurementSet(db, ctx, { customer_id: c.id, unit: 'in', values: { waist: 36 } });
  const o2 = await C.createOrder(db, ctx, { customer_id: c.id, items: [{ garment_type: 'Trouser' }], total_price: 1000, due_date: '2026-10-21' });
  ok(s1.id !== s2.id); eq((await R.currentMeasurementSet(db, c.id)).id, s2.id);
  eq(o1.items[0].measurement_set_id, s1.id, 'old order still on old set'); eq(o2.items[0].measurement_set_id, s2.id, 'new order defaults to newest');
  const stored = await run(db, ['measurement_sets'], 'readonly', (s) => req(s.measurement_sets.get(s1.id)));
  eq(stored.values, { waist: 34 }, 'old set never changed');
  t.log('2 sets kept; order 1 -> set 1 (waist 34), order 2 -> set 2 (waist 36)');
});

test('12 Payments, overpayment confirmation, void, refund', async (t) => {
  const { db } = await fresh(); const ctx = await mkCtx(db);
  const o = await C.createOrder(db, ctx, { new_customer: { full_name: 'P' }, items: [{ garment_type: 'Shirt' }], total_price: 50000, deposit: 20000, due_date: '2026-10-20' });
  await rejects(C.addPayment(db, ctx, { order_id: o.order.id, amount: 40000 }), 'OverpaymentError');
  const r = await C.addPayment(db, ctx, { order_id: o.order.id, amount: 40000, allow_overpay: true });
  let b = await R.getBundle(db, o.order.id); eq(D.financials(b.order, b.payments).status, 'Overpaid');
  await C.voidPayment(db, ctx, r.payment.id, 'typo');
  await C.addPayment(db, ctx, { order_id: o.order.id, amount: 30000 });
  await C.addPayment(db, ctx, { order_id: o.order.id, amount: 5000, type: 'refund', note: 'goodwill' });
  b = await R.getBundle(db, o.order.id);
  eq(D.financials(b.order, b.payments), { paid: 45000, balance: 5000, status: 'Part-paid' });
  t.log('20000 + 30000 - 5000 refund (40000 voided) = paid 45000, balance 5000');
});

test('13 Status: backward needs confirmation, undo works, history kept', async (t) => {
  const { db } = await fresh(); const ctx = await mkCtx(db);
  const o = await C.createOrder(db, ctx, { new_customer: { full_name: 'S' }, items: [{ garment_type: 'Shirt' }], total_price: 1000, due_date: '2026-10-20' });
  const id = o.items[0].id;
  await C.changeItemStatus(db, ctx, id, 'Sewing'); await C.changeItemStatus(db, ctx, id, 'Ready');
  await rejects(C.changeItemStatus(db, ctx, id, 'Fitting'), 'BackwardMoveError');
  const u = await C.undoLastStatus(db, ctx, id); eq(u.status, 'Sewing'); ok(u.ready_at === null, 'ready_at cleared');
  const d = await C.changeItemStatus(db, ctx, id, 'Delivered'); ok(d.delivered_at && d.ready_at, 'jump to Delivered stamps both');
  const b = await R.getBundle(db, o.order.id);
  eq(b.events.sort((x, y) => x.seq - y.seq).map((e) => e.to_status), ['New', 'Sewing', 'Ready', 'Sewing', 'Delivered']);
  t.log('history: New, Sewing, Ready, Sewing (undo), Delivered');
});

test('14 Cancel order requires payment resolution', async (t) => {
  const { db } = await fresh(); const ctx = await mkCtx(db);
  const o = await C.createOrder(db, ctx, { new_customer: { full_name: 'X' }, items: [{ garment_type: 'A' }, { garment_type: 'B' }], total_price: 1000, deposit: 400, due_date: '2026-10-20' });
  await rejects(C.cancelOrder(db, ctx, o.order.id, { reason: 'changed mind' }));
  await C.cancelOrder(db, ctx, o.order.id, { reason: 'changed mind', resolution: { type: 'refund' } });
  const b = await R.getBundle(db, o.order.id);
  ok(b.order.cancelled_at && b.items.every((i) => i.status === 'Cancelled'));
  eq(D.financials(b.order, b.payments).paid, 0, 'refund recorded');
  eq(D.orderSummary(b.items), 'Cancelled');
});

test('15 Domain: order summaries', async () => {
  const it = (...s) => s.map((status) => ({ status }));
  eq(D.orderSummary(it('Ready', 'Sewing')), 'Sewing — 1 of 2 ready');
  eq(D.orderSummary(it('Ready', 'Delivered')), 'Ready — 1 of 2 delivered');
  eq(D.orderSummary(it('Delivered', 'Delivered')), 'Delivered — all items delivered');
  eq(D.orderSummary(it('Cutting', 'Sewing')), 'Cutting / Sewing');
  eq(D.orderSummary(it('Ready')), 'Ready'); eq(D.orderSummary(it('Ready', 'Ready', 'Ready')), 'Ready — all 3 items');
  eq(D.orderSummary(it('Cancelled', 'Ready')), 'Ready'); eq(D.orderSummary(it('Cancelled')), 'Cancelled');
});

test('16 Domain: Today buckets (each order once; fittings separate)', async (t) => {
  const today = '2026-10-04';
  const o = (id, due, extra = {}) => ({ id, due_date: due, total_price: 100, event_date: null, cancelled_at: null, ...extra });
  const it = (status, extra = {}) => ({ status, ...extra });
  const pay = (a) => [{ amount: a, type: 'payment' }];
  const bundles = [
    { order: o('overdue+balance', '2026-10-01'), items: [it('Sewing'), it('Ready')], payments: pay(10) },
    { order: o('soon', '2026-10-05'), items: [it('Cutting')], payments: pay(100) },
    { order: o('event', '2026-10-20', { event_date: '2026-10-08' }), items: [it('Sewing')], payments: pay(100) },
    { order: o('awaiting', '2026-10-02'), items: [it('Ready')], payments: pay(100) },
    { order: o('partial-delivered', '2026-10-02'), items: [it('Delivered'), it('Ready')], payments: pay(100) },
    { order: o('balance-only', '2026-09-20'), items: [it('Delivered')], payments: pay(40) },
    { order: o('cancelled', '2026-10-01', { cancelled_at: 'x' }), items: [it('Cancelled')], payments: [] },
    { order: o('fitting-only', '2026-10-30'), items: [it('Fitting', { fitting_date: '2026-10-05' })], payments: pay(100) },
  ];
  const r = D.todayBuckets(bundles, today);
  const idsOf = (k) => r[k].map((x) => x.order.id);
  eq(idsOf('overdue'), ['overdue+balance']); eq(r.overdue[0].badges, ['balances']); eq(r.overdue[0].daysLate, 3);
  eq(idsOf('eventAtRisk'), ['event']); eq(idsOf('dueSoon'), ['soon']);
  eq(idsOf('awaitingCollection').sort(), ['awaiting', 'partial-delivered']); eq(idsOf('balances'), ['balance-only']);
  eq(r.fittings.map((x) => x.order.id), ['fitting-only']);
  const primary = ['overdue', 'eventAtRisk', 'dueSoon', 'awaitingCollection', 'balances'].flatMap(idsOf);
  eq(new Set(primary).size, primary.length, 'no order twice in the primary list');
  t.log('primary: ' + primary.join(', ') + ' | fittings strip: fitting-only | cancelled: absent');
});

test('17 Domain: phone, dates, money status, validation', async () => {
  for (const p of ['08031234567', '+2348031234567', '+234 803 123 4567', '2348031234567', '8031234567']) eq(D.normalizePhone(p), '+2348031234567', p);
  eq(D.normalizePhone('abc'), null); eq(D.normalizePhone('123'), null);
  eq(D.localDate(new Date(2026, 9, 4, 23, 59)), '2026-10-04'); eq(D.addDays('2026-10-30', 3), '2026-11-02'); eq(D.daysBetween('2026-10-04', '2026-10-01'), -3);
  ok(!D.isDate('2026-02-30'));
  eq(D.financials({ total_price: 100000 }, [{ amount: 50000, type: 'payment' }, { amount: 30000, type: 'payment', voided_at: 'x' }, { amount: 10000, type: 'refund' }]), { paid: 40000, balance: 60000, status: 'Part-paid' });
  eq(D.orderWarnings({ due_date: '2026-10-01', event_date: '2026-09-30', total_price: 10, deposit: 20 }, '2026-10-04'), ['Due date is in the past', 'Ready after the event', 'Deposit is more than the price']);
});

/* ---------------- runner ---------------- */
const TEST_TIMEOUT_MS = 30000;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMED OUT after ${ms / 1000}s: this test hung`)), ms))]);
const esc = (m) => String(m).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const results = [];
const list = document.getElementById('list');
const sumEl = document.getElementById('sum');
for (let i = 0; i < tests.length; i++) {
  const { name, fn } = tests[i];
  sumEl.textContent = `Running test ${i + 1} of ${tests.length}: ${name}`;
  window.__PROGRESS__ = { i, name, at: Date.now() };
  const ev = []; const row = { name, pass: false, evidence: ev, error: null };
  try { await withTimeout(fn({ log: (m) => ev.push(m) }), TEST_TIMEOUT_MS); row.pass = true; } catch (e) { row.error = `${e.name}: ${e.message}`; }
  results.push(row);
  const div = document.createElement('div'); div.className = 'card';
  div.innerHTML = `<span class="${row.pass ? 'pass' : 'fail'}">${row.pass ? 'PASS' : 'FAIL'}</span> ${esc(name)}` + (row.error ? `<div class="ev fail">${esc(row.error)}</div>` : '') + ev.map((m) => `<div class="ev">${esc(m)}</div>`).join('');
  list.appendChild(div);
}
sumEl.textContent = 'Cleaning up test databases…';
for (const d of opened) { try { d.close(); } catch { /* ignore */ } }
for (const n of names) await deleteDb(n);
const passed = results.filter((r) => r.pass).length;
sumEl.innerHTML = `<b class="${passed === results.length ? 'pass' : 'fail'}">${passed} of ${results.length} tests passed</b> · Chrome ${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '?'}`;
const text = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.error ? '\n   ' + r.error : ''}${r.evidence.map((m) => '\n   - ' + m).join('')}`).join('\n') + `\n\n${passed}/${results.length} passed`;
document.getElementById('out').textContent = text;
document.getElementById('copy').onclick = () => navigator.clipboard?.writeText(text);
window.__RESULTS__ = results; window.__TEXT__ = text; window.__DONE__ = true;
