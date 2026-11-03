/* Per-white-board Markdown mirror in a folder you choose (e.g. the repo a Claude session works in).
 *   app -> file : whenever the board changes, the file is rewritten.
 *   file -> app : the file is polled; edits to note blocks (moves, text, logs, new notes) are imported.
 * Safety rules:
 *   - an external edit is only imported if the file still derives from the state we last wrote/accepted
 *     (its rev matches); a stale or foreign file is overwritten by the app instead
 *   - notes are never deleted by a file edit
 *   - the Rust side only reads/writes files named tiger-*.md inside the chosen folder
 */
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { store, touch } from './store.js';
import { uid } from './model.js';
import { renderBoard, parseBoard, parseRev, applyParsed, boardRev } from './boardmd.js';

const hasTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
const slug = t => (t || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board';
const state = new Map();     // epic id -> { lastDisk, baseRev, skipExport, busy }
let hooks = { onImported: () => {}, onProblem: () => {} };

export const boardFileName = e => (e.outputFile ||= 'tiger-' + slug(e.title) + '-' + e.id.slice(0, 4) + '.md');
export const boardFilePath = e => e.outputPath + (e.outputPath.includes('\\') ? '\\' : '/') + boardFileName(e);

export async function pickFolder(current) {
  if (!hasTauri()) return null;
  const r = await open({ directory: true, multiple: false, defaultPath: current || undefined, title: 'Choose the output folder for this white board' });
  return typeof r === 'string' ? r : null;
}

async function reconcile(p, e, appChanged) {
  if (!hasTauri() || !e.outputPath) return;
  const s = state.get(e.id) || state.set(e.id, { lastDisk: null, baseRev: null, skipExport: false, busy: false }).get(e.id);
  if (s.busy) return; s.busy = true;
  try {
    const name = boardFileName(e);
    const disk = await invoke('mirror_read', { dir: e.outputPath, name });
    let imported = false, needExport = appChanged || disk == null;
    if (disk != null && disk !== s.lastDisk) {                       // changed by someone else (or first look this session)
      const diskRev = parseRev(disk), base = s.baseRev ?? boardRev(e);
      const parsed = diskRev === base ? parseBoard(disk) : null;
      if (parsed) {
        if (applyParsed(e, parsed, uid)) { imported = true; s.skipExport = true; touch(p); hooks.onImported(p, e); }
        s.lastDisk = disk; s.baseRev = diskRev;
      } else needExport = true;                                     // stale / foreign file: app wins
    }
    if (needExport && !s.skipExport) {
      const md = renderBoard(p, e);
      if (md !== disk) await invoke('mirror_write', { dir: e.outputPath, name, content: md });
      s.lastDisk = md; s.baseRev = boardRev(e);
    }
    if (!imported) s.skipExport = false;
  } catch (err) {
    hooks.onProblem(`Board file for "${e.title || 'white board'}": ${err && err.message ? err.message : err}`);
  } finally { s.busy = false; }
}

const pending = new Map();
function scheduleExport(p, e, ms) {
  clearTimeout(pending.get(e.id));
  pending.set(e.id, setTimeout(() => reconcile(p, e, true), ms));
}
const withOutput = fn => { for (const p of store.projects) for (const e of p.epics) if (e.outputPath) fn(p, e); };

export function initMirror(h) {
  hooks = { ...hooks, ...h };
  store.on('touch', p => {
    for (const e of p.epics) {
      if (!e.outputPath) continue;
      const s = state.get(e.id);
      if (s && s.skipExport) { s.skipExport = false; continue; }     // this touch came from importing the file
      scheduleExport(p, e, 800);
    }
  });
  store.on('change', () => withOutput((p, e) => scheduleExport(p, e, 300)));   // remote sync changed data
  setInterval(() => { if (document.visibilityState === 'visible') withOutput((p, e) => reconcile(p, e, false)); }, 3000);
  setTimeout(() => withOutput((p, e) => reconcile(p, e, false)), 1500);
}

/** Called right after the user picks/clears a folder. */
export function outputChanged(p, e) {
  state.delete(e.id);
  if (e.outputPath) { boardFileName(e); scheduleExport(p, e, 100); }
}
