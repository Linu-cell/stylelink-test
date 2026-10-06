// Boot, routing and global error handling.
import { SCHEMA_VERSION, DB_NAME } from './version.js';
import { openDb, inspectDb } from './db.js';
import { getContext } from './commands.js';
import { getMeta, setMeta } from './repo.js';
import { initSW, applyUpdate } from './swclient.js';
import * as V from './views.js';

const rootEl = document.getElementById('app');
const bannerEl = document.getElementById('banner');
const navEl = document.getElementById('nav');
const app = { db: null, ctx: null, ready: false };
const ROUTES = { '#/today': V.todayView, '#/settings': V.settingsView };

app.toast = (kind, text) => V.addBanner(bannerEl, kind, text);
app.refreshContext = async () => { app.ctx = await getContext(app.db); };
app.render = async () => {
  if (!app.ready) return;
  let hash = location.hash;
  if (!ROUTES[hash]) { hash = '#/today'; history.replaceState(null, '', hash); }
  navEl.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.route === hash));
  rootEl.replaceChildren(await ROUTES[hash](app));
};
window.addEventListener('hashchange', () => app.render());

async function reportError(e) {
  const msg = String((e && e.message) || e);
  V.addBanner(bannerEl, 'error', 'Something went wrong: ' + msg);
  try { if (app.db) await setMeta(app.db, 'last_error', { message: msg, at: new Date().toISOString() }); } catch { /* best effort */ }
}
window.addEventListener('error', (e) => reportError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason));

async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* optional */ }
}

async function startApp() {
  await app.refreshContext();
  await setMeta(app.db, 'first_run_done', true);
  app.ready = true;
  navEl.classList.remove('hidden');
  if (!location.hash) history.replaceState(null, '', '#/today');
  await app.render();
}

async function openAndStart() {
  app.db = await openDb(DB_NAME, { schemaVersion: SCHEMA_VERSION });
  const done = await getMeta(app.db, 'first_run_done');
  const ws = await getMeta(app.db, 'workspace_id');
  if (!done && !ws) { rootEl.replaceChildren(V.firstRunView(app, startApp)); return; }
  await startApp();
}

async function boot() {
  requestPersist();
  initSW({ onUpdateReady: (reg) => V.showUpdateBanner(bannerEl, () => applyUpdate(reg)) });
  let info;
  try { info = await inspectDb(DB_NAME); } catch (e) { rootEl.replaceChildren(V.errorView('Storage is not available here: ' + e.message)); return; }
  if (info.exists && info.version > SCHEMA_VERSION) { rootEl.replaceChildren(V.updateRequiredView(info.version, SCHEMA_VERSION)); return; }
  if (info.exists && info.version < SCHEMA_VERSION) { rootEl.replaceChildren(V.migrationGateView(app, info.version, SCHEMA_VERSION, openAndStart)); return; }
  try { await openAndStart(); } catch (e) { rootEl.replaceChildren(V.errorView(String(e.message || e))); }
}
boot();
