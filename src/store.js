/* Local-first store + background sync.
 *
 * The app always reads and writes the local cache (localStorage), so it opens instantly and works
 * offline. A sync engine reconciles the cache with a remote backend (Proton Drive) in the background:
 *   - one remote file per project, matched by project id
 *   - last-writer-wins on project.updated; if BOTH sides changed since the last sync, the older version
 *     is kept as a "(conflict copy)" project instead of being overwritten
 *   - deletes propagate through tombstones; locally deleted projects are kept in a small recovery bin
 * The remote needs: index() -> Map(id -> revision), read(id), save(p) -> revision, remove(id).
 */
import { normalizeProject } from './model.js';

const KEY = 'tsn.cache.v1', BIN = 'tsn.bin.v1';
const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();

const listeners = { change: [], status: [], touch: [] };
const emit = (k, v) => listeners[k].forEach(f => { try { f(v); } catch (e) { console.error(e); } });

export const store = {
  projects: [],
  deleted: {},     // id -> iso time (tombstones awaiting remote delete)
  synced: {},      // id -> { rev, updated } as of last successful sync
  remote: null,
  on(kind, f) { listeners[kind].push(f); },
};

/* ---------- local persistence ---------- */
let saveTimer = null;
function persistNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try { localStorage.setItem(KEY, JSON.stringify({ projects: store.projects, deleted: store.deleted, synced: store.synced })); }
  catch (e) { emit('status', { kind: 'error', text: 'Could not save locally: ' + e.message }); }
}
const persistSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(persistNow, 250); };

export function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (d) { store.projects = (d.projects || []).map(normalizeProject); store.deleted = d.deleted || {}; store.synced = d.synced || {}; return; }
    const legacy = JSON.parse(localStorage.getItem('tsn.projects') || '[]');   // data from the pre-sync version
    if (legacy.length) { store.projects = legacy.map(normalizeProject); persistNow(); }
  } catch { /* start empty */ }
}
export const flushLocal = () => persistNow();

const byCreated = (a, b) => (a.created || '').localeCompare(b.created || '');
export const byId = id => store.projects.find(p => p.id === id);

/* ---------- mutations (called by the UI) ---------- */
export function touch(p) { p.updated = now(); persistSoon(); schedule(2500); emit('touch', p); }
export function add(p) { store.projects.push(p); touch(p); }
export function remove(p) {
  store.projects = store.projects.filter(x => x !== p);
  store.deleted[p.id] = now();
  const bin = JSON.parse(localStorage.getItem(BIN) || '[]'); bin.push({ at: now(), project: p });
  try { localStorage.setItem(BIN, JSON.stringify(bin.slice(-20))); } catch { /* ignore */ }
  persistNow(); schedule(1000);
}

/* ---------- sync engine ---------- */
let running = false, again = false, timer = null, failures = 0;

export function setRemote(r) { store.remote = r; failures = 0; if (r) schedule(200); else emit('status', { kind: 'off' }); }
export function schedule(ms) {
  if (!store.remote) return;
  clearTimeout(timer); timer = setTimeout(sync, ms);
}
const isEditing = () => { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && !!a.closest('#app'); };

export async function sync() {
  const remote = store.remote; if (!remote) return;
  if (running) { again = true; return; }
  running = true; again = false; clearTimeout(timer);
  emit('status', { kind: 'syncing' });
  let changed = false, deferred = false;
  try {
    const idx = await remote.index();
    const editing = isEditing();
    const localIds = new Set(store.projects.map(p => p.id));
    const ids = new Set([...idx.keys(), ...localIds, ...Object.keys(store.deleted)]);

    for (const id of ids) {
      const L = byId(id), inR = idx.has(id), rev = idx.get(id), sy = store.synced[id];

      if (store.deleted[id]) {                                   // deleted here -> delete there
        if (inR) await remote.remove(id);
        delete store.deleted[id]; delete store.synced[id]; continue;
      }
      if (!L && inR) {                                           // new on the other side -> download
        const R = normalizeProject(await remote.read(id)); store.projects.push(R); store.synced[id] = { rev, updated: R.updated }; changed = true; continue;
      }
      if (L && !inR) {
        if (sy) {                                                // it was synced before, now gone remotely -> deleted elsewhere
          if (editing) { deferred = true; continue; }
          store.projects = store.projects.filter(p => p !== L); delete store.synced[id];
          const bin = JSON.parse(localStorage.getItem(BIN) || '[]'); bin.push({ at: now(), project: L, why: 'deleted on another device' });
          try { localStorage.setItem(BIN, JSON.stringify(bin.slice(-20))); } catch { /* ignore */ }
          changed = true;
        } else {                                                 // never uploaded -> upload
          const snap = L.updated; store.synced[id] = { rev: await remote.save(L), updated: snap };
        }
        continue;
      }
      if (!L) continue;
      // exists on both sides
      const localDirty = !sy || L.updated !== sy.updated;
      const remoteChanged = !sy || sy.rev !== rev;
      if (!remoteChanged) {
        if (localDirty) { const snap = L.updated; store.synced[id] = { rev: await remote.save(L), updated: snap }; }
        continue;
      }
      const R = normalizeProject(await remote.read(id));
      if (!localDirty) {                                         // only the remote changed -> take it
        if (editing) { deferred = true; continue; }
        store.projects[store.projects.indexOf(L)] = R; store.synced[id] = { rev, updated: R.updated }; changed = true; continue;
      }
      if (R.updated === L.updated) { store.synced[id] = { rev, updated: L.updated }; continue; }   // same content version
      // both changed: newer wins, older survives as a conflict copy
      const [newer, older] = R.updated > L.updated ? [R, L] : [L, R];
      const copy = { ...older, id: uid(), name: (older.name || 'Untitled') + ' (conflict copy)', created: now(), updated: now() };
      store.projects[store.projects.indexOf(L)] = newer;
      store.projects.push(copy);
      store.synced[id] = { rev: await remote.save(newer), updated: newer.updated };
      store.synced[copy.id] = { rev: await remote.save(copy), updated: copy.updated };
      changed = true;
    }
    store.projects.sort(byCreated);
    persistNow(); failures = 0;
    emit('status', { kind: 'ok', at: new Date() });
    if (changed) emit('change');
  } catch (e) {
    failures++;
    persistNow();
    emit('status', { kind: 'error', text: (e && e.message) || String(e) });
    schedule(Math.min(30000 * failures, 300000));
  } finally {
    running = false;
    if (deferred) schedule(5000);
    else if (again) schedule(500);
  }
}

/* periodic + on-focus sync */
setInterval(() => { if (document.visibilityState === 'visible') schedule(100); }, 90000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
window.addEventListener('online', () => schedule(300));
window.addEventListener('beforeunload', () => persistNow());
