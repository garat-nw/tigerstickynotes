/* In-app Proton Drive sign-in dialog + connection test. Works in any webview (desktop or iPad). */
import { login, submit2fa, submitMailboxPassword, logout, signedInAs, protonBackend, HumanVerificationError } from './proton.js';

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v; else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}

export function openProtonDialog({ onUse, onSignOut }) {
  let view = signedInAs() ? 'done' : 'login';
  let creds = { user: '' }, hvInfo = null, busy = false, error = '';
  const logLines = [];
  const log = t => { logLines.push(t); render(); };

  const overlay = h('div', { class: 'modal' });
  const close = () => { window.removeEventListener('message', onMsg); overlay.remove(); };
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.body.append(overlay);

  /* Proton's hosted CAPTCHA page reports success through postMessage (format unverified; we log anything else). */
  function onMsg(ev) {
    if (ev.origin !== 'https://verify.proton.me') return;
    const d = ev.data;
    if (d && d.type === 'HUMAN_VERIFICATION_SUCCESS' && d.payload?.token) retryWithHv({ token: d.payload.token, type: d.payload.type || 'captcha' });
    else log('verify.proton.me message: ' + JSON.stringify(d).slice(0, 200));
  }
  window.addEventListener('message', onMsg);

  async function run(fn) {
    busy = true; error = ''; render();
    try { await fn(); }
    catch (e) {
      if (e instanceof HumanVerificationError) { hvInfo = e; view = 'hv'; }
      else error = (e && e.message) || String(e);
    } finally { busy = false; render(); }
  }
  const handle = async r => {
    view = r.step;
    if (r.step === 'done') { log('Signed in. Opening your Proton Drive folder…'); await onUse(await protonBackend()); log('✅ Syncing with Proton Drive. You stay signed in on this device.'); }
  };
  const retryWithHv = hv => run(async () => await handle(await login(creds.user, creds.pass, hv)));

  function field(label, type, key, props = {}) {
    return h('label', { class: 'fld' }, label, h('input', { type, autocomplete: 'off', value: creds[key] || '', oninput: e => { creds[key] = e.target.value; }, ...props }));
  }

  function body() {
    if (view === 'login') return [
      h('p', { class: 'notice' }, 'Tiger Sticky Notes is a personal, unofficial third-party app. It is not made, endorsed or supported by Proton. Your password is used on this device to sign in and unlock your keys; it is not stored.'),
      field('Proton email or username', 'text', 'user'),
      field('Password', 'password', 'pass'),
      h('button', { class: 'primary', disabled: busy || null, onclick: () => run(async () => await handle(await login(creds.user.trim(), creds.pass))) }, busy ? 'Signing in…' : 'Sign in'),
    ];
    if (view === '2fa') return [
      h('p', {}, 'Enter the 6-digit code from your authenticator app.'),
      field('2FA code', 'text', 'code', { inputmode: 'numeric', maxlength: 8 }),
      h('button', { class: 'primary', disabled: busy || null, onclick: () => run(async () => await handle(await submit2fa(creds.code || ''))) }, 'Verify'),
    ];
    if (view === 'mailbox') return [
      h('p', {}, 'This account uses a separate mailbox password.'),
      field('Mailbox password', 'password', 'mailbox'),
      h('button', { class: 'primary', disabled: busy || null, onclick: () => run(async () => await handle(await submitMailboxPassword(creds.mailbox || ''))) }, 'Unlock'),
    ];
    if (view === 'hv') {
      const url = 'https://verify.proton.me/?embed=1&methods=' + encodeURIComponent((hvInfo.methods || ['captcha']).join(',')) + '&token=' + encodeURIComponent(hvInfo.token || '');
      return [
        h('p', {}, 'Proton wants to confirm you are human. Complete the check below; sign-in continues automatically.'),
        h('iframe', { class: 'hvframe', src: url, referrerpolicy: 'no-referrer' }),
        h('details', {}, h('summary', {}, 'It did not continue? Paste the verification token manually'),
          field('Token', 'text', 'hvtoken'),
          h('button', { class: 'ghost2', onclick: () => retryWithHv({ token: creds.hvtoken || '', type: 'captcha' }) }, 'Retry with token')),
      ];
    }
    // signed in
    return [
      h('p', {}, '✅ Signed in as ', h('b', {}, signedInAs() || creds.user), '. Keys unlocked.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: busy || null, onclick: () => run(async () => {
          log('Opening/creating the TigerStickyNotes folder…');
          const b = await protonBackend(); log('Folder ready. Writing a test file, reading it back…');
          const ok = await b.selfTest(); log(ok ? '✅ Round trip OK: wrote, read back and matched.' : '❌ Read-back did not match what was written.');
        }) }, 'Run storage test'),
        h('button', { class: 'danger', onclick: () => { logout(); onSignOut && onSignOut(); view = 'login'; creds = { user: creds.user }; logLines.length = 0; render(); } }, 'Sign out')),
    ];
  }

  function render() {
    overlay.replaceChildren(h('div', { class: 'dialog' },
      h('div', { class: 'dhead' }, h('b', {}, '☁ Proton Drive'), h('button', { class: 'x', onclick: close }, '✕')),
      ...body(),
      error ? h('p', { class: 'err' }, error) : null,
      logLines.length ? h('pre', { class: 'log' }, logLines.join('\n')) : null));
    const first = overlay.querySelector('input'); if (first && !first.value && !busy) first.focus();
  }
  render();
}
