// Backup core: build, validate, migrate older files, restore (atomic) with snapshot + undo.
import { run, req, dumpTx, DATA_STORES, META_BACKUP_KEYS, MIGRATIONS } from './db.js';
import { APP_VERSION, SCHEMA_VERSION } from './version.js';

export const FORMAT = 'stylelink-orders-backup';

export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const countsOf = (data) => Object.fromEntries(DATA_STORES.map((n) => [n, data[n].length]));

export async function packBackup(data, { schemaVersion = SCHEMA_VERSION, appVersion = APP_VERSION, now = () => new Date().toISOString() } = {}) {
  return { format: FORMAT, schema_version: schemaVersion, app_version: appVersion, exported_at: now(), workspace_id: data.meta.workspace_id || null, counts: countsOf(data), checksum: await sha256(canon(data)), data };
}
export async function buildBackup(db, opts) {
  const data = await run(db, [...DATA_STORES, 'meta'], 'readonly', (s) => dumpTx(s));
  return packBackup(data, opts);
}
export const serializeBackup = (obj) => JSON.stringify(obj);
export const backupFileName = (d = new Date()) => { const p = (n) => String(n).padStart(2, '0'); return `stylelink-orders-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`; };

export function migrateData(data, from, to, migrations = MIGRATIONS) {
  const steps = migrations.filter((m) => m.to > from && m.to <= to && m.transform).sort((a, b) => a.to - b.to);
  const out = { meta: { ...data.meta } };
  for (const n of DATA_STORES) out[n] = data[n].map((r) => steps.reduce((row, m) => m.transform(n, row), r));
  return out;
}

const REFS = [['orders', 'customer_id', 'customers'], ['measurement_sets', 'customer_id', 'customers'], ['order_items', 'order_id', 'orders'], ['order_items', 'measurement_set_id', 'measurement_sets', true], ['payments', 'order_id', 'orders'], ['status_events', 'order_item_id', 'order_items']];

// Never touches the database. Returns {ok, errors, data (migrated), summary}.
export async function validateBackup(obj, { schemaVersion = SCHEMA_VERSION, migrations = MIGRATIONS } = {}) {
  const bad = (errors) => ({ ok: false, errors });
  if (!obj || typeof obj !== 'object') return bad(['Not a backup file']);
  if (obj.format !== FORMAT) return bad(['Not a Stylelink Orders backup file']);
  if (!Number.isInteger(obj.schema_version) || obj.schema_version < 1) return bad(['Backup has no valid schema version']);
  if (obj.schema_version > schemaVersion) return bad([`Backup is from a newer version (schema ${obj.schema_version}). Update the app first`]);
  const d = obj.data;
  if (!d || typeof d !== 'object' || !d.meta || typeof d.meta !== 'object') return bad(['Backup data is missing']);
  const missing = DATA_STORES.filter((n) => !Array.isArray(d[n]));
  if (missing.length) return bad([`Backup is missing tables: ${missing.join(', ')}`]);
  if ((await sha256(canon(d))) !== obj.checksum) return bad(['Backup is damaged: checksum does not match']);
  const counts = countsOf(d);
  const off = DATA_STORES.filter((n) => !obj.counts || obj.counts[n] !== counts[n]);
  if (off.length) return bad([`Record counts do not match for: ${off.join(', ')}`]);
  const data = obj.schema_version < schemaVersion ? migrateData(d, obj.schema_version, schemaVersion, migrations) : d;
  const ids = Object.fromEntries(DATA_STORES.map((n) => [n, new Set(data[n].map((r) => r.id))]));
  const errors = [];
  for (const [tbl, field, target, optional] of REFS) {
    const n = data[tbl].filter((r) => !(optional && !r[field]) && !ids[target].has(r[field])).length;
    if (n) errors.push(`${n} ${tbl} record(s) point to a missing ${target} record`);
  }
  if (errors.length) return bad(errors);
  return { ok: true, errors: [], data, needsMigration: obj.schema_version < schemaVersion, summary: { counts, exported_at: obj.exported_at, schema_version: obj.schema_version, app_version: obj.app_version } };
}
export async function validateBackupText(text, opts) {
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, errors: ['File is not readable (cut off or not a backup)'] }; }
  return validateBackup(obj, opts);
}

async function replaceAll(s, data) {
  for (const n of DATA_STORES) { s[n].clear(); for (const r of data[n]) s[n].put(r); }
  for (const k of META_BACKUP_KEYS) { if (k in data.meta) s.meta.put({ key: k, value: data.meta[k] }); else s.meta.delete(k); }
}
const SNAP_STORES = [...DATA_STORES, 'meta', 'snapshots'];

// One transaction: snapshot current data, then replace everything. Any failure leaves current data untouched.
export function restoreBackup(db, validated, { schemaVersion = SCHEMA_VERSION, now = () => new Date().toISOString() } = {}) {
  if (!validated || !validated.ok) return Promise.reject(new Error('Backup has not been validated'));
  return run(db, SNAP_STORES, 'readwrite', async (s) => {
    const current = await dumpTx(s);
    s.snapshots.put({ id: 'pre-restore', created_at: now(), schema_version: schemaVersion, data: current });
    await replaceAll(s, validated.data);
    return countsOf(validated.data);
  });
}
export const hasSnapshot = (db, id) => run(db, ['snapshots'], 'readonly', async (s) => !!(await req(s.snapshots.get(id))));
export function undoLastRestore(db) {
  return run(db, SNAP_STORES, 'readwrite', async (s) => {
    const snap = await req(s.snapshots.get('pre-restore'));
    if (!snap) throw new Error('There is no restore to undo');
    await replaceAll(s, snap.data);
    s.snapshots.delete('pre-restore');
    return countsOf(snap.data);
  });
}
