// Screens for Step 2: Today (stub), Settings, first-run, update-required, migration gate.
import { APP_VERSION, SCHEMA_VERSION, DB_NAME, BUILD_KIND } from './version.js';
import { buildBackup, serializeBackup, backupFileName, validateBackupText, restoreBackup, undoLastRestore, hasSnapshot } from './backup.js';
import { openAtCurrent } from './db.js';
import { getMeta, setMeta } from './repo.js';
import { localDate, daysBetween, CONSTANTS } from './domain.js';
import { shareOrDownload, pickFile } from './files.js';

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

export function backupStatus(lastIso, now = new Date(), warnDays = CONSTANTS.backupWarnDays) {
  if (!lastIso) return { level: 'warn', days: null, label: 'No backup yet' };
  const days = daysBetween(localDate(new Date(lastIso)), localDate(now));
  const label = days <= 0 ? 'Last backup: today' : days === 1 ? 'Last backup: yesterday' : `Last backup: ${days} days ago`;
  return { level: days >= warnDays ? 'warn' : 'ok', days, label };
}

export function addBanner(container, kind, text, action) {
  const node = h('div', { class: `banner ${kind}`, role: 'status' }, h('span', { text }),
    action ? h('button', { text: action.label, onclick: action.run }) : h('button', { 'aria-label': 'Dismiss', text: '✕', onclick: () => node.remove() }));
  container.append(node);
  return node;
}
export function showUpdateBanner(container, run) {
  if (container.querySelector('#update-banner')) return;
  const n = addBanner(container, 'info', 'A new version is ready.', { label: 'Update now', run });
  n.id = 'update-banner';
}

const testNotice = () => (BUILD_KIND === 'test' ? h('div', { class: 'card warn', id: 'test-notice' }, h('b', { class: 'warn', text: 'Test build: use fake data only.' }), h('div', { class: 'sub', text: 'Real customer data must not be entered here.' })) : null);

/* ---------- shared flows ---------- */
export async function runBackup(db, box, onSaved) {
  const text = serializeBackup(await buildBackup(db, { schemaVersion: db.version }));
  const name = backupFileName();
  await setMeta(db, 'last_backup_attempt_at', new Date().toISOString());
  const res = await shareOrDownload(name, text);
  if (res === 'cancelled') { box.replaceChildren(h('p', { id: 'backup-msg', class: 'sub', text: 'Backup cancelled. Nothing was changed.' })); return; }
  box.replaceChildren(
    h('p', { id: 'backup-msg', text: res === 'downloaded' ? `The backup file (${name}) was saved to this phone's Downloads.` : `The backup file (${name}) was shared.` }),
    h('p', { class: 'b', text: 'Did you save it somewhere outside this app (Google Drive, WhatsApp, email)?' }),
    h('button', { id: 'btn-saved-yes', class: 'btn', text: 'Yes, saved', onclick: async () => {
      await setMeta(db, 'last_backup_at', new Date().toISOString());
      box.replaceChildren(h('p', { id: 'backup-msg', class: 'ok b', text: 'Backup recorded.' }));
      await onSaved();
    } }),
    h('button', { id: 'btn-saved-no', class: 'btn sec', text: 'No, not yet', onclick: () => box.replaceChildren(h('p', { id: 'backup-msg', class: 'sub', text: 'Not recorded. Your last confirmed backup is unchanged.' })) }));
}

export async function restoreFlow(app, box, onRestored) {
  const text = await pickFile();
  if (text == null) return;
  const v = await validateBackupText(text);
  if (!v.ok) {
    box.replaceChildren(h('p', { id: 'restore-msg', class: 'bad b', text: "This file can't be restored. Nothing was changed." }), h('ul', {}, v.errors.map((e) => h('li', { text: e }))));
    return;
  }
  const s = v.summary;
  box.replaceChildren(
    h('p', { id: 'restore-msg', class: 'b', text: 'Restoring REPLACES all data on this phone with this backup.' }),
    h('p', { class: 'sub', text: `Backup made ${s.exported_at} · app ${s.app_version} · data format ${s.schema_version}` }),
    h('ul', { id: 'restore-counts' }, Object.entries(s.counts).map(([k, n]) => h('li', { text: `${k.replace(/_/g, ' ')}: ${n}` }))),
    h('button', { id: 'btn-replace', class: 'btn danger', text: 'Replace all data', onclick: async () => {
      try {
        await restoreBackup(app.db, v);
        await setMeta(app.db, 'first_run_done', true);
        await app.refreshContext();
        await onRestored();
      } catch (e) { box.replaceChildren(h('p', { id: 'restore-msg', class: 'bad b', text: 'Restore failed. Your data was not changed.' }), h('p', { class: 'sub', text: String(e.message || e) })); }
    } }),
    h('button', { id: 'btn-cancel-restore', class: 'btn sec', text: 'Cancel', onclick: () => box.replaceChildren() }));
}

/* ---------- screens ---------- */
export async function todayView(app) {
  const st = backupStatus(await getMeta(app.db, 'last_backup_at'));
  return h('section', {}, h('h1', { text: 'Today' }), testNotice(),
    h('div', { id: 'backup-indicator', class: `card ${st.level}` },
      h('b', { id: 'backup-label', class: st.level, text: st.label }),
      st.level === 'warn' ? h('div', { class: 'sub', text: 'Back up in Settings so your data is safe.' }) : null,
      h('a', { class: 'btn small', href: '#/settings', text: 'Open Settings' })),
    h('div', { class: 'card' }, h('b', { text: 'Nothing here yet' }), h('div', { class: 'sub', text: 'Customers, orders and the full Today list arrive in later steps.' })));
}

export async function settingsView(app) {
  const db = app.db;
  const snap = await hasSnapshot(db, 'pre-restore');
  const label = h('b', { id: 'backup-label' });
  const paint = async () => { const st = backupStatus(await getMeta(db, 'last_backup_at')); label.textContent = st.label; label.className = st.level; };
  await paint();
  const bbox = h('div', { id: 'backup-box' }); const rbox = h('div', { id: 'restore-box' });
  const bbtn = h('button', { id: 'btn-backup', class: 'btn', text: 'Back up now', onclick: async () => {
    bbtn.disabled = true;
    try { await runBackup(db, bbox, paint); } catch (e) { bbox.replaceChildren(h('p', { class: 'bad b', text: 'Backup failed: ' + (e.message || e) })); }
    bbtn.disabled = false;
  } });
  return h('section', {}, h('h1', { text: 'Settings' }), testNotice(),
    h('div', { class: 'card' }, h('h2', { text: 'Backup' }), label, h('div', { class: 'sub', text: 'Your data lives only on this phone. Save a backup file outside the app often.' }), bbtn, bbox),
    h('div', { class: 'card' }, h('h2', { text: 'Restore' }),
      h('button', { id: 'btn-restore', class: 'btn sec', text: 'Restore from a backup file', onclick: () => restoreFlow(app, rbox, async () => { app.toast('ok', 'Restore complete.'); await app.render(); }) }),
      snap ? h('button', { id: 'btn-undo', class: 'btn sec', text: 'Undo last restore', onclick: async () => {
        try { await undoLastRestore(db); await app.refreshContext(); app.toast('ok', 'Restore undone. Your previous data is back.'); await app.render(); }
        catch (e) { app.toast('error', 'Undo failed: ' + (e.message || e)); }
      } }) : null, rbox),
    h('div', { class: 'card' }, h('h2', { text: 'Versions' }), h('dl', { class: 'kv' },
      h('dt', { text: 'App version' }), h('dd', { id: 'ver-app', text: APP_VERSION }),
      h('dt', { text: 'Data format' }), h('dd', { id: 'ver-schema', text: String(SCHEMA_VERSION) }),
      h('dt', { text: 'Database' }), h('dd', { id: 'ver-db', text: DB_NAME }))),
    h('div', { class: 'card' }, h('details', {}, h('summary', { text: 'Install help' }), installSteps())));
}

const installSteps = () => h('div', {}, h('p', { class: 'sub', text: 'On Android, open this page in Chrome, tap the ⋮ menu, then Install app (or Add to Home screen). Open it from the new icon.' }),
  h('p', { class: 'sub', text: 'Clearing Chrome data or uninstalling the app erases the data on this phone unless you have a backup file.' }));

export function firstRunView(app, finish) {
  const box = h('div', { id: 'restore-box' });
  return h('section', { id: 'first-run' }, h('h1', { text: 'Welcome' }), testNotice(),
    h('div', { class: 'card' }, h('h2', { text: 'Before you start' }), installSteps(),
      h('p', { class: 'b', text: 'Your data stays on this phone. Back it up regularly.' })),
    h('div', { class: 'card' },
      h('button', { id: 'btn-start-fresh', class: 'btn', text: 'Start fresh', onclick: async () => { await setMeta(app.db, 'first_run_done', true); await finish(); } }),
      h('button', { id: 'btn-first-restore', class: 'btn sec', text: 'Restore from backup', onclick: () => restoreFlow(app, box, async () => { await finish(); }) }),
      box));
}

export function updateRequiredView(found, appSchema) {
  return h('section', { id: 'update-required' }, h('h1', { text: 'Update required' }),
    h('div', { class: 'card warn' }, h('p', { class: 'b', text: 'The data on this phone is from a newer version of the app.' }),
      h('p', { class: 'sub', text: `Stored data format ${found}; this app understands ${appSchema}. Nothing has been changed. Close the app fully and reopen it to get the latest version.` })));
}

export const errorView = (msg) => h('section', { id: 'fatal' }, h('h1', { text: 'Cannot start' }), h('div', { class: 'card warn' }, h('p', { class: 'bad b', text: msg })));

export function migrationGateView(app, from, to, proceed) {
  const box = h('div', { id: 'gate-box' }); const msg = h('div', { id: 'gate-msg' });
  let saved = false; let warned = false;
  const up = h('button', { id: 'btn-upgrade', class: 'btn', text: 'Upgrade now', onclick: async () => {
    if (!saved && !warned) { warned = true; up.textContent = 'Yes, upgrade without a backup'; msg.replaceChildren(h('p', { class: 'warn b', text: 'No backup saved yet. A safety copy is made automatically, but a backup file is safer.' })); return; }
    up.disabled = true;
    try { await proceed(); }
    catch (e) { up.disabled = false; msg.replaceChildren(h('p', { id: 'gate-error', class: 'bad b', text: 'Upgrade failed. Your data was not changed.' }), h('p', { class: 'sub', text: String(e.message || e) })); }
  } });
  let gateDb = null;
  const bk = h('button', { id: 'btn-gate-backup', class: 'btn sec', text: 'Back up now', onclick: async () => {
    try { gateDb = gateDb || await openAtCurrent(DB_NAME); await runBackup(gateDb, box, async () => { saved = true; up.textContent = 'Upgrade now'; }); }
    catch (e) { box.replaceChildren(h('p', { class: 'bad b', text: 'Backup failed: ' + (e.message || e) })); }
  } });
  return h('section', { id: 'migration-gate' }, h('h1', { text: 'Update needs your data upgraded' }),
    h('div', { class: 'card warn' }, h('p', { class: 'b', text: `This update changes how data is stored (format ${from} to ${to}).` }),
      h('p', { class: 'sub', text: 'A safety copy is saved automatically before the upgrade. Please also save a backup file.' }), bk, box, up, msg));
}
