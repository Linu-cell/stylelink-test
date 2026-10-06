// IndexedDB layer: open + migrations + atomic unit of work.
import { SCHEMA_VERSION } from './version.js';

export const DATA_STORES = ['workspaces', 'users', 'customers', 'measurement_sets', 'orders', 'order_items', 'payments', 'status_events'];
export const META_BACKUP_KEYS = ['workspace_id', 'user_id', 'order_counter'];

export class SchemaTooNewError extends Error {
  constructor(found, app) { super(`Stored data is schema ${found} but this app understands ${app}. Update the app.`); this.name = 'SchemaTooNewError'; this.found = found; this.app = app; }
}

export const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// Each migration: structural upgrade(db, tx) + pure row transform(storeName, row).
export const MIGRATIONS = [{
  to: 1,
  transform: null,
  upgrade(db) {
    const mk = (n, idx = []) => { const s = db.createObjectStore(n, { keyPath: 'id' }); idx.forEach(([a, b]) => s.createIndex(a, b)); };
    mk('workspaces'); mk('users');
    mk('customers', [['by_name', 'full_name_lc'], ['by_phone', 'phone_norm']]);
    mk('measurement_sets', [['by_customer', 'customer_id']]);
    mk('orders', [['by_customer', 'customer_id'], ['by_due', 'due_date'], ['by_no', 'order_no']]);
    mk('order_items', [['by_order', 'order_id'], ['by_status', 'status']]);
    mk('payments', [['by_order', 'order_id']]);
    mk('status_events', [['by_item', 'order_item_id']]);
    db.createObjectStore('meta', { keyPath: 'key' });
    mk('snapshots');
  },
}];

// Atomic unit of work. Inside fn, only await IndexedDB requests (use req()).
// Any other await lets the browser auto-commit the transaction early.
export function run(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); } catch (e) { return reject(e); }
    let result; let failure = null; let txDone = false; let fnDone = false; let settled = false;
    const finish = (err, val) => { if (settled) return; settled = true; if (err) reject(err); else resolve(val); };
    // Resolve only when BOTH the transaction committed AND fn finished without error.
    const check = () => { if (txDone && fnDone) finish(failure, result); };
    tx.oncomplete = () => { txDone = true; check(); };
    tx.onabort = () => finish(failure || tx.error || new Error('Transaction aborted'));
    const s = {};
    for (const n of stores) s[n] = tx.objectStore(n);
    (async () => {
      try { result = await fn(s, tx); } catch (e) { failure = e; try { tx.abort(); } catch { /* already finished */ } } finally { fnDone = true; check(); }
    })();
  });
}

export async function dumpTx(s) {
  const data = {};
  for (const n of DATA_STORES) data[n] = await req(s[n].getAll());
  const meta = {};
  for (const r of await req(s.meta.getAll())) if (META_BACKUP_KEYS.includes(r.key)) meta[r.key] = r.value;
  data.meta = meta;
  return data;
}

async function preMigrationSnapshot(name, version) {
  const db = await new Promise((res, rej) => { const r = indexedDB.open(name, version); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try {
    const names = [...DATA_STORES, 'meta', 'snapshots'];
    if (!names.every((n) => db.objectStoreNames.contains(n))) return;
    await run(db, names, 'readwrite', async (s) => {
      const data = await dumpTx(s);
      s.snapshots.put({ id: 'pre-migration', created_at: new Date().toISOString(), schema_version: version, data });
    });
  } finally { db.close(); }
}

export async function openDb(name, { schemaVersion = SCHEMA_VERSION, migrations = MIGRATIONS } = {}) {
  const existing = (await indexedDB.databases()).find((d) => d.name === name);
  if (existing && existing.version > schemaVersion) throw new SchemaTooNewError(existing.version, schemaVersion);
  if (existing && existing.version < schemaVersion) await preMigrationSnapshot(name, existing.version);
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(name, schemaVersion);
    rq.onupgradeneeded = (e) => {
      const db = rq.result; const tx = rq.transaction; const from = e.oldVersion;
      const pending = migrations.filter((m) => m.to > from && m.to <= schemaVersion).sort((a, b) => a.to - b.to);
      pending.forEach((m) => m.upgrade(db, tx));
      const transforms = pending.map((m) => m.transform).filter(Boolean);
      if (from > 0 && transforms.length) {
        for (const n of DATA_STORES) {
          if (!db.objectStoreNames.contains(n)) continue;
          const st = tx.objectStore(n);
          st.getAll().onsuccess = (ev) => ev.target.result.forEach((r) => st.put(transforms.reduce((row, t) => t(n, row), r)));
        }
      }
    };
    rq.onsuccess = () => { const db = rq.result; db.onversionchange = () => db.close(); resolve(db); };
    rq.onerror = () => reject(rq.error);
    rq.onblocked = () => reject(new Error('Upgrade blocked by another open copy of the app'));
  });
}

export const deleteDb = (name) => new Promise((res) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });

// Added in Step 2 for the migration gate (read-only helpers).
export async function inspectDb(name) {
  const e = (await indexedDB.databases()).find((x) => x.name === name);
  return e ? { exists: true, version: e.version } : { exists: false, version: 0 };
}
export function openAtCurrent(name) {
  return new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => { const db = r.result; db.onversionchange = () => db.close(); res(db); }; r.onerror = () => rej(r.error); });
}
