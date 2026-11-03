'use strict';
/* Tiger Sticky Notes — vanilla JS app. Local-first: data lives in the local cache (src/store.js) and
   syncs to Proton Drive in the background (one small JSON file per project). */

import { openProtonDialog } from './proton/dialog.js';
import { resumeSession, protonBackend } from './proton/proton.js';
import { COLS, uid, now } from './model.js';
import { initMirror, pickFolder, outputChanged, boardFileName, boardFilePath } from './mirror.js';
import { store, load, byId, touch, add as addProject, remove as removeProject, setRemote, sync } from './store.js';


function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}
const grow = t => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };

/* ---------- state ---------- */
const $app = document.getElementById('app');
const $status = document.getElementById('status');
const $proton = document.getElementById('proton');

/* ---------- sync status + Proton connection ---------- */
const hhmm = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
store.on('status', s => {
  if (s.kind === 'syncing') { $proton.textContent = '☁ Syncing…'; $status.textContent = ''; }
  else if (s.kind === 'ok') { $proton.textContent = '☁ Synced ' + hhmm(s.at); $status.textContent = ''; }
  else if (s.kind === 'error') { $proton.textContent = '⚠ Not synced'; $status.textContent = (s.text || '').slice(0, 90) + ' — changes are saved on this device'; }
  else $proton.textContent = '☁ Sign in to sync';
});
store.on('change', () => route());

async function connectProton() {
  $proton.textContent = '☁ Connecting…';
  try {
    const r = await resumeSession();
    if (r === 'none') { localStorage.removeItem('tsn.remote'); store.remote = null; $proton.textContent = '☁ Sign in to sync'; return; }
    if (r === 'ok') { setRemote(await protonBackend()); return; }
    throw new Error('offline');
  } catch (e) {
    $proton.textContent = '⚠ Not synced'; $status.textContent = 'Could not reach Proton — retrying';
    setTimeout(connectProton, 30000);
  }
}

/* ---------- views: Home (projects) -> Project (white boards) -> White board (kanban) ---------- */
const nav = () => { const q = new URLSearchParams(location.hash.slice(1)); return { p: q.get('p'), e: q.get('e') }; };
const go = (p, e) => { location.hash = p ? 'p=' + p + (e ? '&e=' + e : '') : ''; };

function route() {
  const { p: pid, e: eid } = nav();
  const p = byId(pid);
  const e = p && p.epics.find(x => x.id === eid);
  const crumbs = [];
  if (p) crumbs.push(h('span', {}, '›'), e ? h('a', { href: '#p=' + p.id }, p.name || 'Untitled') : h('b', {}, p.name || 'Untitled'));
  if (e) crumbs.push(h('span', {}, '›'), h('b', {}, e.title || 'White board'));
  $('crumbs').replaceChildren(h('a', { href: '#' }, 'Projects'), ...crumbs);
  document.title = (e ? e.title : p ? p.name : 'Tiger Sticky Notes') + ' · Tiger Sticky Notes';
  $app.replaceChildren(e ? boardPage(p, e) : p ? projectPage(p) : homePage());
  $app.querySelectorAll('textarea').forEach(grow);
}
function $(id) { return document.getElementById(id); }

/* Home: only the list of projects, as folders */
function homePage() {
  const folders = store.projects.map(p => {
    const n = p.epics.reduce((s, e) => s + e.notes.length, 0);
    return h('div', { class: 'folder', onclick: () => go(p.id) },
      h('div', { class: 'sheet' }),
      h('div', { class: 'front' },
        h('h3', {}, p.name || 'Untitled'),
        h('p', {}, p.description || ''),
        h('div', { class: 'meta' }, p.epics.length + ' white board' + (p.epics.length === 1 ? '' : 's') + ' · ' + n + ' note' + (n === 1 ? '' : 's'))));
  });
  const add = h('div', { class: 'folder new', onclick: () => {
    const p = { id: uid(), name: '', description: '', created: now(), updated: now(), epics: [] };
    addProject(p); go(p.id);
  } }, h('div', { class: 'front' }, '+ New project'));
  return h('div', {}, h('h1', { class: 'page' }, 'Projects'), h('div', { class: 'shelf' }, folders, add));
}

/* Project: only the white boards in it (plus the project's outcome brief) */
function projectPage(p) {
  const name = h('input', { class: 'name', value: p.name, placeholder: 'Project name' });
  name.addEventListener('input', () => { p.name = name.value; touch(p); });
  const desc = h('textarea', { rows: 2, placeholder: 'What outcome are you going for with this project?', value: p.description });
  desc.addEventListener('input', () => { p.description = desc.value; grow(desc); touch(p); });

  const frames = p.epics.map(e => h('div', { class: 'frame', onclick: () => go(p.id, e.id) },
    h('div', { class: 'surf' },
      h('h3', {}, e.title || 'Untitled'),
      h('div', { class: 'out' }, e.outcome || ''),
      h('div', { class: 'mini' }, COLS.map(([k]) => h('div', {}, e.notes.filter(n => n.status === k).slice(0, 12).map(() => h('i')))))),
    h('div', { class: 'tray' })));
  const add = h('div', { class: 'frame new', onclick: () => {
    const e = { id: uid(), title: '', outcome: '', notes: [] }; p.epics.push(e); touch(p); go(p.id, e.id);
  } }, h('div', { class: 'surf' }, '+ New white board'));

  return h('div', {},
    h('div', { class: 'brief' }, name, h('div', { class: 'lbl' }, 'Outcome'), desc),
    h('div', { class: 'hang' }, frames, add),
    h('div', { class: 'wb-actions' }, h('button', { class: 'danger', onclick: () => {
      if (!confirm('Delete project "' + (p.name || 'Untitled') + '" and everything in it?')) return;
      removeProject(p); go();
    } }, 'Delete project')));
}

/* White board: one epic, full focus */
function boardPage(p, e) {
  const title = h('input', { class: 'wb-title', value: e.title, placeholder: 'White board title' });
  title.addEventListener('input', () => { e.title = title.value; touch(p); });
  const outcome = h('textarea', { class: 'wb-outcome', rows: 1, placeholder: 'Outcome I’m going for on this board…', value: e.outcome });
  outcome.addEventListener('input', () => { e.outcome = outcome.value; grow(outcome); touch(p); });

  const kan = h('div', { class: 'kan' }, COLS.map(([key, label]) => {
    const cards = h('div', { class: 'cards' }, e.notes.filter(n => n.status === key).map(n => noteView(p, e, n)));
    const col = h('div', { class: 'col', 'data-status': key },
      h('h4', {}, label, h('button', { class: 'add', title: 'Add sticky note', onclick: () => addNote(p, e, key) }, '+')), cards);
    col.addEventListener('dragover', ev => { ev.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', ev => { if (!col.contains(ev.relatedTarget)) col.classList.remove('over'); });
    col.addEventListener('drop', ev => {
      ev.preventDefault(); col.classList.remove('over');
      const id = ev.dataTransfer.getData('text/plain'); if (!id) return;
      let before = null;
      for (const el of cards.children) { const r = el.getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { before = el.dataset.id; break; } }
      moveNote(p, e, id, key, before);
    });
    return col;
  }));

  const tray = h('div', { class: 'tray-bar' },
    h('i', { class: 'marker', style: 'left:12%;width:64px;background:#1d1d22;color:#1d1d22' }),
    h('i', { class: 'marker', style: 'left:calc(12% + 80px);width:64px;background:#1f4fb3;color:#1f4fb3' }),
    h('i', { class: 'marker', style: 'left:calc(12% + 160px);width:64px;background:#c4271f;color:#c4271f' }),
    h('i', { class: 'eraser' }));

  return h('div', { class: 'wb-wrap' },
    h('div', { class: 'wb-frame' }, h('div', { class: 'wb-surf' }, title, outcome, kan)),
    tray,
    outputRow(p, e),
    h('div', { class: 'wb-actions' }, h('button', { class: 'danger', onclick: () => {
      if (e.notes.length && !confirm('Delete this white board and its ' + e.notes.length + ' notes?')) return;
      p.epics = p.epics.filter(x => x !== e); touch(p); go(p.id);
    } }, 'Delete white board')));
}

function outputRow(p, e) {
  const set = e.outputPath;
  return h('div', { class: 'outrow' },
    h('span', { class: 'lbl' }, 'Output folder'),
    h('code', { class: 'path', title: set ? boardFilePath(e) : '' }, set || 'not set — Claude sessions can’t see this board yet'),
    h('button', { class: 'ghost2', onclick: async () => {
      const dir = await pickFolder(e.outputPath);
      if (!dir) return;
      e.outputPath = dir; touch(p); outputChanged(p, e); route();
    } }, set ? 'Change…' : 'Browse…'),
    set ? h('button', { class: 'ghost2', title: boardFilePath(e), onclick: async ev => {
      try { await navigator.clipboard.writeText(boardFilePath(e)); ev.target.textContent = 'Copied ✓'; setTimeout(() => { ev.target.textContent = 'Copy file path'; }, 1500); } catch { prompt('Board file path', boardFilePath(e)); }
    } }, 'Copy file path') : null,
    set ? h('button', { class: 'danger', onclick: () => { e.outputPath = ''; touch(p); outputChanged(p, e); route(); } }, 'Clear') : null,
    set ? h('span', { class: 'fname' }, boardFileName(e)) : null);
}

function noteView(p, e, n) {
  const ta = h('textarea', { rows: 1, placeholder: 'Short thought…', value: n.text });
  ta.addEventListener('input', () => { n.text = ta.value; grow(ta); touch(p); });
  ta.addEventListener('keydown', ev => { if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) ta.blur(); });
  const logArea = h('textarea', { class: 'notelog', rows: 2, placeholder: 'Log: what was done, tried, or why it is blocked…', value: n.log || '' });
  logArea.addEventListener('input', () => { n.log = logArea.value; grow(logArea); touch(p); el.classList.toggle('haslog', !!n.log.trim()); });
  const idx = COLS.findIndex(c => c[0] === n.status);
  const step = d => () => moveNote(p, e, n.id, COLS[idx + d][0], null);
  const el = h('div', { class: 'note' + (n.log && n.log.trim() ? ' haslog' : '') + (n.status === 'blocked' ? ' blocked' : ''), 'data-id': n.id, style: '--rot:' + ((parseInt(n.id.slice(0, 3), 36) % 7 - 3) * 0.5) + 'deg' },
    h('div', { class: 'stripes' }), h('div', { class: 'topband' }), ta, logArea,
    h('div', { class: 'tools' },
      h('span', { class: 'grip', draggable: true, title: 'Drag', ondragstart: ev => {
        ev.dataTransfer.setData('text/plain', n.id); ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setDragImage(el, 20, 10); setTimeout(() => el.classList.add('dragging'), 0);
      }, ondragend: () => el.classList.remove('dragging') }, '⠿'),
      h('button', { class: 'logbtn', title: 'Show / hide log', onclick: () => { el.classList.toggle('logopen'); grow(logArea); } }, '📝'),
      idx > 0 ? h('button', { title: 'Move back', onclick: step(-1) }, '◀') : null,
      idx < COLS.length - 1 ? h('button', { title: 'Move forward', onclick: step(1) }, '▶') : null,
      h('button', { class: 'del', title: 'Delete', onclick: () => { e.notes = e.notes.filter(x => x !== n); touch(p); route(); } }, '✕')));
  return el;
}

function addNote(p, e, status) {
  const n = { id: uid(), text: '', status };
  e.notes.push(n); touch(p); route();
  const ta = $app.querySelector('.note[data-id="' + n.id + '"] textarea'); ta && ta.focus();
}

function moveNote(p, e, id, status, beforeId) {
  const n = e.notes.find(x => x.id === id);
  if (!n) return;
  e.notes = e.notes.filter(x => x !== n);
  n.status = status;
  const at = beforeId ? e.notes.findIndex(x => x.id === beforeId) : -1;
  if (at < 0) e.notes.push(n); else e.notes.splice(at, 0, n);
  touch(p); route();
}

/* ---------- boot ---------- */
window.addEventListener('hashchange', route);
$proton.addEventListener('click', () => openProtonDialog({
  onUse: async b => {                         // signed in: start syncing with Proton Drive
    localStorage.setItem('tsn.remote', 'proton');
    setRemote(b);
  },
  onSignOut: () => { localStorage.removeItem('tsn.remote'); setRemote(null); },
}));
load();
route();
initMirror({
  onImported: () => { const again = () => (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) ? setTimeout(again, 3000) : route()); again(); },
  onProblem: t => { $status.textContent = t.slice(0, 120); },
});
connectProton();   // the OS keychain is the source of truth: if a saved session exists we resume it
