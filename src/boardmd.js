/* White board <-> Markdown. Pure functions (no Tauri/DOM) so they can be unit tested.
 *
 * File shape (the part an agent edits is only the note blocks and which "## Column" they sit under):
 *
 *   <!-- tiger-board v1 epic:ID rev:HASH -->
 *   # Title
 *   ## Outcome            (read-only for the agent)
 *   ## How to work this board
 *   ## Backlog / ## In progress / ## Blocked / ## Done
 *   <!-- note:ID -->
 *   text...
 *   <details><summary>log</summary>
 *
 *   log...
 *
 *   </details>
 *   <!-- /note -->
 */
import { COLS } from './model.js';

const HEADINGS = Object.fromEntries(COLS.map(([k, l]) => [l, k]));

/** Short stable hash of everything the file represents. */
export function boardRev(e) {
  const s = JSON.stringify([e.title, e.outcome, e.notes.map(n => [n.id, n.status, n.text, n.log || ''])]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function renderBoard(project, e) {
  const out = [];
  out.push(`<!-- tiger-board v1 epic:${e.id} rev:${boardRev(e)} -->`);
  out.push(`# ${(e.title || 'Untitled white board').replace(/\n/g, ' ')}`);
  out.push(`_Project: ${(project.name || 'Untitled').replace(/\n/g, ' ')}_`, '');
  out.push('## Outcome', '', (e.outcome || '_(no outcome written yet)_').trim(), '');
  out.push('## How to work this board', '',
    '- The Backlog is **unordered**: pick whichever note makes the most sense next.',
    '- Before starting a note, move its whole block (`<!-- note:... -->` through `<!-- /note -->`) under **## In progress**. When it is finished and verified, move it under **## Done**.',
    '- If you hit something that needs a human (a decision, access, an unclear requirement, a failing thing you cannot fix), move the note under **## Blocked**, write why in its log, and **stop**.',
    '- Record what you did and tried in each note\'s log (inside the `<details>` block). Keep note text short; put detail in the log.',
    '- Add a new note by adding a block starting `<!-- note:new -->` under the right heading. Never delete notes or change the `note:ID` markers.',
    '- Keep working until Backlog and In progress are empty, or you are blocked. Then stop and summarise.', '');
  for (const [key, label] of COLS) {
    out.push(`## ${label}`, '');
    for (const n of e.notes.filter(x => x.status === key)) {
      out.push(`<!-- note:${n.id} -->`, (n.text || '').trim());
      if ((n.log || '').trim()) out.push('<details><summary>log</summary>', '', n.log.trim(), '', '</details>');
      out.push('<!-- /note -->', '');
    }
  }
  return out.join('\n');
}

export function parseRev(md) { return (/^<!--\s*tiger-board v1 [^>]*\brev:(\S+?)\s*-->/.exec(md) || [])[1] || null; }

/** Returns [{id, status, text, log}] in file order, or null if this is not a tiger board file. */
export function parseBoard(md) {
  if (!/^<!--\s*tiger-board v1/.test(md)) return null;
  const lines = md.split(/\r?\n/), notes = [];
  let status = null, cur = null;
  for (const line of lines) {
    if (cur) {
      if (/^<!--\s*\/note\s*-->\s*$/.test(line)) { notes.push(finish(cur)); cur = null; } else cur.lines.push(line);
      continue;
    }
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { status = HEADINGS[h[1]] || null; continue; }
    const m = /^<!--\s*note:(\S+?)\s*-->\s*$/.exec(line);
    if (m && status) cur = { id: m[1], status, lines: [] };
  }
  return notes;
}

function finish(c) {
  const i = c.lines.findIndex(l => /^<details>/.test(l));
  const text = (i < 0 ? c.lines : c.lines.slice(0, i)).join('\n').trim();
  let log = '';
  if (i >= 0) {
    const end = c.lines.findIndex((l, k) => k > i && /^<\/details>/.test(l));
    log = c.lines.slice(i + 1, end < 0 ? undefined : end).join('\n').trim();
  }
  return { id: c.id, status: c.status, text, log };
}

/** Apply parsed notes to epic e. Never deletes. Returns true if anything changed. */
export function applyParsed(e, parsed, newId) {
  let changed = false;
  const byId = new Map(e.notes.map(n => [n.id, n]));
  const order = [];
  for (const pn of parsed) {
    let n = byId.get(pn.id);
    if (!n) { n = { id: newId(), text: pn.text, status: pn.status, log: pn.log }; e.notes.push(n); changed = true; }
    else {
      if (n.text !== pn.text) { n.text = pn.text; changed = true; }
      if ((n.log || '') !== pn.log) { n.log = pn.log; changed = true; }
      if (n.status !== pn.status) { n.status = pn.status; changed = true; }
    }
    order.push(n);
  }
  const rest = e.notes.filter(n => !order.includes(n));   // notes missing from the file stay put
  const next = [...order, ...rest];
  const seq = (list, st) => list.filter(n => n.status === st).map(n => n.id).join(',');
  if (COLS.some(([st]) => seq(e.notes, st) !== seq(next, st))) { e.notes = next; changed = true; }   // reorder only if a column's order differs
  return changed;
}
