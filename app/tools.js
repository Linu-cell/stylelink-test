// Development-only: seeds FAKE data into the test database, shows counts, wipes it.
import { DB_NAME, BUILD_KIND } from './version.js';
import { openDb, deleteDb, run, req, DATA_STORES } from './db.js';
import * as C from './commands.js';
import { addDays, localDate } from './domain.js';

const out = document.getElementById('out');
const say = (t) => { out.textContent = t; };
if (BUILD_KIND !== 'test') { say('Disabled: this is not a test build.'); document.querySelectorAll('button').forEach((b) => { b.disabled = true; }); }

async function counts() {
  const db = await openDb(DB_NAME);
  try {
    const c = await run(db, DATA_STORES, 'readonly', async (s) => { const o = {}; for (const n of DATA_STORES) o[n] = (await req(s[n].getAll())).length; return o; });
    return `Database ${DB_NAME}\n` + DATA_STORES.map((n) => `${n}: ${c[n]}`).join('\n');
  } finally { db.close(); }
}

async function seed() {
  const db = await openDb(DB_NAME);
  try {
    const ctx = await C.getContext(db);
    const today = localDate(); const tag = String(Date.now()).slice(-4);
    const names = ['Fake Ada', 'Fake Bola', 'Fake Chidi'];
    for (let i = 0; i < names.length; i++) {
      const c = await C.createCustomer(db, ctx, { full_name: `${names[i]} ${tag}`, phone: `0803000${tag.slice(-4)}`.slice(0, 11) });
      await C.saveMeasurementSet(db, ctx, { customer_id: c.id, unit: 'in', values: { chest: 38 + i, waist: 32 + i } });
      const o = await C.createOrder(db, ctx, { customer_id: c.id, items: [{ garment_type: 'Agbada' }, { garment_type: 'Trouser' }], total_price: 80000 + i * 10000, deposit: 30000, due_date: addDays(today, 5 + i * 5) });
      await C.changeItemStatus(db, ctx, o.items[0].id, 'Cutting');
    }
  } finally { db.close(); }
}

const guard = (fn) => async () => { try { say(await fn()); } catch (e) { say('Error: ' + (e.message || e)); } };
document.getElementById('seed').onclick = guard(async () => { await seed(); return 'Added 3 fake customers with orders.\n\n' + (await counts()); });
document.getElementById('counts').onclick = guard(counts);
let armed = false;
document.getElementById('wipe').onclick = guard(async () => {
  if (!armed) { armed = true; return 'Tap "Wipe test database" again to confirm. This deletes everything in ' + DB_NAME + '.'; }
  armed = false; await deleteDb(DB_NAME); return 'Test database wiped. Reload the app to see the first-run screen.';
});
