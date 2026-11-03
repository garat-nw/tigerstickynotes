/* Shared data model helpers. */
export const COLS = [['backlog', 'Backlog'], ['progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];
export const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
export const now = () => new Date().toISOString();

/** Bring projects written by older versions up to date (Reviewed -> Blocked, notes get a log). */
export function normalizeProject(p) {
  for (const e of p.epics || []) {
    for (const n of e.notes || []) {
      if (n.status === 'reviewed') n.status = 'blocked';
      if (typeof n.log !== 'string') n.log = '';
    }
  }
  return p;
}
