/* Proton Drive connection: login (SRP), key unlock, SDK client, and a storage backend.
 *
 * UNOFFICIAL third-party client. Proton's SDK does not ship login, so this file implements it
 * from the same public building blocks the official clients use (@protontech/crypto SRP + OpenPGP).
 * Endpoint paths / field names come from Proton's SDK docs and community clients and are
 * UNVERIFIED against the live API until the first real login. Everything runs in the webview;
 * network goes through Tauri's native HTTP plugin (no CORS), allow-listed to *.proton.me.
 * Session lives in memory only (no password / token is written to disk).
 */
import '@protontech/crypto/polyfill';
import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { getSrp, computeKeyPassword, generateKeySalt } from '@protontech/crypto/srp';
import { ProtonDriveClient, MemoryCache, OpenPGPCryptoWithCryptoProxy, NodeType } from '@protontech/drive-sdk';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';

/* OS keychain (Windows Credential Manager / macOS+iOS Keychain) via Rust commands. No-op in a plain browser. */
const hasTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
const secretGet = async () => (hasTauri() ? invoke('secret_get') : null);
const secretSet = async v => { if (hasTauri()) await invoke('secret_set', { value: v }); };
const secretDelete = async () => { if (hasTauri()) await invoke('secret_delete'); };

const HOST = 'drive-api.proton.me';
const BASE = 'https://' + HOST + '/';
const APP_VERSION = 'external-drive-tigerstickynotes@0.1.0-stable';   // Proton asks third-party apps to identify themselves
const FOLDER = 'TigerStickyNotes';
const SUFFIX = '.tiger.json';

export class HumanVerificationError extends Error {
  constructor(details) { super('Proton asks for human verification'); this.token = details?.HumanVerificationToken; this.methods = details?.HumanVerificationMethods || ['captcha']; }
}
export class ProtonError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status; } }

let cryptoReady = null;
const initCrypto = () => cryptoReady ||= (async () => {
  await CryptoApi.init({});
  CryptoProxy.setEndpoint(new CryptoApi(), endpoint => endpoint.clearKeyStore());
})();

/* ---------- session + HTTP ---------- */
const S = { uid: null, access: null, refresh: null, username: null, passwordMode: 1, hv: null, keyPassword: null, userKeyPass: {},
            userKeys: [], addresses: [], client: null, pending: null };

function headers(extra = {}, authed = true) {
  const h = new Headers({ 'x-pm-appversion': APP_VERSION, Accept: 'application/vnd.protonmail.api+json', ...extra });
  if (authed && S.uid) { h.set('x-pm-uid', S.uid); h.set('Authorization', 'Bearer ' + S.access); }
  if (S.hv) { h.set('x-pm-human-verification-token', S.hv.token); h.set('x-pm-human-verification-token-type', S.hv.type); }
  return h;
}

async function refreshTokens() {
  if (!S.refresh) throw new ProtonError('Session expired — sign in again', 0, 401);
  const h = headers({ 'Content-Type': 'application/json' }, false); h.set('x-pm-uid', S.uid);
  const r = await nativeFetch(BASE + 'auth/v4/refresh', { method: 'POST', headers: h,
    body: JSON.stringify({ ResponseType: 'token', GrantType: 'refresh_token', RefreshToken: S.refresh, RedirectURI: 'https://proton.me' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.AccessToken) throw new ProtonError('Session expired — sign in again', j.Code, r.status);
  S.access = j.AccessToken; S.refresh = j.RefreshToken;
  persistSession();   // refresh tokens rotate, so the keychain copy must follow
}

/** Authenticated fetch with one automatic refresh on 401. Used by both our calls and the SDK. */
async function authedFetch(url, init) {
  const send = () => { const h = new Headers(init.headers || {}); for (const [k, v] of headers({}, true)) h.set(k, v); return nativeFetch(url, { ...init, headers: h }); };
  let r = await send();
  if (r.status === 401 && S.refresh) { await refreshTokens(); r = await send(); }
  return r;
}

async function api(path, { method = 'GET', json, authed = true } = {}) {
  const init = { method, headers: { 'Content-Type': 'application/json' }, body: json ? JSON.stringify(json) : undefined };
  const r = authed ? await authedFetch(BASE + path, init) : await nativeFetch(BASE + path, { ...init, headers: headers({ 'Content-Type': 'application/json' }, false) });
  const j = await r.json().catch(() => ({}));
  if (j.Code === 9001) throw new HumanVerificationError(j.Details);
  if (!r.ok || (j.Code && j.Code !== 1000)) throw new ProtonError(j.Error || ('HTTP ' + r.status), j.Code, r.status);
  return j;
}

/* ---------- login ---------- */
/** Step 1: SRP login. Returns {step:'2fa'|'mailbox'|'done'}; throws HumanVerificationError if Proton wants a CAPTCHA. */
export async function login(username, password, humanVerification) {
  await initCrypto();
  Object.assign(S, { uid: null, access: null, refresh: null, keyPassword: null, userKeys: [], addresses: [], client: null, username });
  S.hv = humanVerification || null;
  const info = await api('auth/v4/info', { method: 'POST', json: { Username: username }, authed: false });
  const srp = await getSrp(info, { username, password });
  const auth = await api('auth/v4', { method: 'POST', authed: false,
    json: { Username: username, ClientEphemeral: srp.clientEphemeral, ClientProof: srp.clientProof, SRPSession: info.SRPSession } });
  if (auth.ServerProof !== srp.expectedServerProof) throw new ProtonError('Server proof mismatch — aborting for safety', 0, 0);
  Object.assign(S, { uid: auth.UID, access: auth.AccessToken, refresh: auth.RefreshToken, passwordMode: auth.PasswordMode });
  S.pending = { password };
  const tfa = auth['2FA']?.Enabled || 0;
  if (tfa & 1) return { step: '2fa' };
  if (tfa) throw new ProtonError('This account requires a security key (FIDO2) for 2FA, which is not supported yet. Use an authenticator-app code instead.', 0, 0);
  return afterAuth();
}

/** Step 2 (if needed): TOTP code. */
export async function submit2fa(code) {
  await api('auth/v4/2fa', { method: 'POST', json: { TwoFactorCode: code.replace(/\s+/g, '') } });
  return afterAuth();
}

/** Step 3 (two-password accounts only). */
export async function submitMailboxPassword(mailbox) { S.pending.password = mailbox; return unlock(); }

async function afterAuth() {
  if (S.passwordMode === 2) return { step: 'mailbox' };
  return unlock();
}

async function unlock() {
  const password = S.pending.password; S.pending = null;
  const [{ User }, { KeySalts }] = await Promise.all([api('core/v4/users'), api('core/v4/keys/salts')]);
  S.userKeyPass = {};
  for (const k of User.Keys) {
    const ks = KeySalts.find(x => x.ID === k.ID)?.KeySalt; if (!ks) continue;
    S.userKeyPass[k.ID] = await computeKeyPassword(password, ks);
  }
  await loadKeys(User);
  persistSession();
  return { step: 'done', user: S.username };
}

/** Import user + address keys using the per-key passphrases (from login, or restored from the keychain). */
async function loadKeys(userMaybe) {
  const User = userMaybe || (await api('core/v4/users')).User;
  const { Addresses } = await api('core/v4/addresses');
  S.userKeys = [];
  for (const k of User.Keys) {
    const pass = S.userKeyPass[k.ID]; if (!pass) continue;
    try { S.userKeys.push(await CryptoProxy.importPrivateKey({ armoredKey: k.PrivateKey, passphrase: pass })); } catch { /* not unlockable */ }
  }
  if (!S.userKeys.length) throw new ProtonError('Wrong password for key unlock, or unsupported key type', 0, 0);
  const primary = User.Keys.find(k => k.Primary) || User.Keys[0];
  S.keyPassword = S.userKeyPass[primary.ID];
  S.addresses = [];
  for (const a of Addresses.filter(x => x.Status === 1).sort((x, y) => x.Order - y.Order)) {
    const keys = [];
    for (const k of a.Keys) {
      try {
        let pass = S.keyPassword;
        if (k.Token) pass = (await CryptoProxy.decryptMessage({ armoredMessage: k.Token, decryptionKeys: S.userKeys, format: 'utf8' })).data;
        keys.push({ id: k.ID, primary: !!k.Primary, key: await CryptoProxy.importPrivateKey({ armoredKey: k.PrivateKey, passphrase: pass }) });
      } catch { /* skip keys we cannot unlock */ }
    }
    if (keys.length) S.addresses.push({ email: a.Email, addressId: a.ID, keys });
  }
  if (!S.addresses.length) throw new ProtonError('No usable address keys were found', 0, 0);
  S.client = buildClient();
}

/* ---------- stay signed in ---------- */
async function persistSession() {
  try {
    await secretSet(JSON.stringify({ v: 1, uid: S.uid, access: S.access, refresh: S.refresh, username: S.username, keys: S.userKeyPass }));
  } catch (e) { console.warn('Could not save session to the OS keychain:', e); }
}

/** Restore a saved session. Returns 'ok' | 'none' (not signed in) | 'offline' (could not reach Proton; try again later). */
export async function resumeSession() {
  if (S.client) return 'ok';
  let d;
  try { const raw = await secretGet(); if (!raw) return 'none'; d = JSON.parse(raw); } catch { await secretDelete().catch(() => {}); return 'none'; }
  await initCrypto();
  Object.assign(S, { uid: d.uid, access: d.access, refresh: d.refresh, username: d.username, userKeyPass: d.keys || {}, hv: null });
  try { await loadKeys(); return 'ok'; }
  catch (e) {
    if (e instanceof ProtonError && [400, 401, 403, 422].includes(e.status)) { await secretDelete().catch(() => {}); clearSession(); return 'none'; }
    return 'offline';
  }
}

function clearSession() {
  Object.assign(S, { uid: null, access: null, refresh: null, keyPassword: null, userKeyPass: {}, userKeys: [], addresses: [], client: null, pending: null, hv: null });
}

/* ---------- SDK glue ---------- */
function buildClient() {
  const toAddr = a => ({ email: a.email, addressId: a.addressId, primaryKeyIndex: Math.max(0, a.keys.findIndex(k => k.primary)), keys: a.keys.map(k => ({ id: k.id, key: k.key })) });
  const account = {
    async getOwnPrimaryAddress() { return toAddr(S.addresses[0]); },
    async getOwnAddresses() { return S.addresses.map(toAddr); },
    async getOwnAddress(q) { const a = S.addresses.find(x => x.email === q || x.addressId === q); if (!a) throw new Error('No such address'); return toAddr(a); },
    async hasProtonAccount() { return true; },
    async getPublicKeys(email) {
      try {
        const j = await api('core/v4/keys/all?Email=' + encodeURIComponent(email));
        return await Promise.all((j.Address?.Keys || []).map(k => CryptoProxy.importPublicKey({ armoredKey: k.PublicKey })));
      } catch { return []; }
    },
  };
  const srpModule = {
    getSrp: (version, modulus, serverEphemeral, salt, password) => getSrp({ Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt }, { password }),
    getSrpVerifier: async () => { throw new Error('not needed for personal storage'); },
    computeKeyPassword, generateKeySalt,
  };
  const wrap = async (req, body) => {
    const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]) : AbortSignal.timeout(req.timeoutMs);
    return authedFetch(req.url, { method: req.method, headers: req.headers, body, signal });
  };
  const httpClient = {
    fetchJson: req => wrap(req, req.json ? JSON.stringify(req.json) : req.body),
    fetchBlob: req => wrap(req, req.body),
  };
  let deviceId = ''; try { deviceId = localStorage.tsnDevice ||= Math.random().toString(36).slice(2, 10); } catch { deviceId = 'x'; }
  return new ProtonDriveClient({
    httpClient, entitiesCache: new MemoryCache(), cryptoCache: new MemoryCache(), account, srpModule,
    openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
    config: { baseUrl: HOST, clientUid: 'tigerstickynotes-' + deviceId },
  });
}

export function logout() {
  if (S.uid) api('auth/v4', { method: 'DELETE' }).catch(() => {});
  secretDelete().catch(() => {});
  clearSession();
  CryptoProxy.clearKeyStore?.().catch?.(() => {});
}
export const signedInAs = () => (S.client ? S.username : null);

/* ---------- storage backend: one <id>.tiger.json per project in My files / TigerStickyNotes ---------- */
const nm = n => (n.name?.ok ? n.name.value : null);

export async function protonBackend() {
  const client = S.client; if (!client) throw new Error('Not signed in');
  const root = await client.getMyFilesRootFolder();
  let dir = null;
  for await (const n of client.iterateFolderChildren(root.uid, { type: NodeType.Folder })) if (nm(n) === FOLDER) { dir = n; break; }
  if (!dir) dir = await client.createFolder(root.uid, FOLDER);
  const uids = new Map();   // file name -> node uid

  const readText = async uid => {
    const dl = await client.getFileDownloader(uid);
    const chunks = [];
    await dl.downloadToStream(new WritableStream({ write(c) { chunks.push(c); } })).completion();
    return new Blob(chunks).text();
  };
  const writeText = async (name, text) => {
    const file = new File([text], name, { type: 'application/json' });
    const meta = { mediaType: 'application/json', expectedSize: file.size, modificationTime: new Date() };
    const up = uids.has(name) ? await client.getFileRevisionUploader(uids.get(name), meta) : await client.getFileUploader(dir.uid, name, meta);
    const done = await (await up.uploadFromFile(file, [])).completion();
    uids.set(name, done.nodeUid);
    return done;
  };

  const revs = new Map();   // file name -> active revision uid

  return {
    label: '☁ Proton Drive',
    proton: true,
    /** Cheap listing: project id -> revision uid. No file downloads. */
    async index() {
      uids.clear(); revs.clear(); const out = new Map();
      for await (const n of client.iterateFolderChildren(dir.uid, { type: NodeType.File })) {
        const name = nm(n); if (!name?.endsWith(SUFFIX)) continue;
        uids.set(name, n.uid); revs.set(name, n.activeRevision?.uid || '');
        out.set(name.slice(0, -SUFFIX.length), n.activeRevision?.uid || String(n.modificationTime?.getTime?.() || ''));
      }
      return out;
    },
    async read(id) { return JSON.parse(await readText(uids.get(id + SUFFIX))); },
    /** Returns the new revision id. */
    async save(p) { const done = await writeText(p.id + SUFFIX, JSON.stringify(p)); return done.nodeRevisionUid; },
    async remove(id) { const uid = uids.get(id + SUFFIX); if (!uid) return; for await (const _ of client.trashNodes([uid])) { /* drain */ } uids.delete(id + SUFFIX); },
    /** Round-trip self test used by the login dialog. */
    async selfTest() {
      const name = 'spike-test.json', payload = { at: new Date().toISOString(), n: Math.random() };
      await writeText(name, JSON.stringify(payload));
      const back = JSON.parse(await readText(uids.get(name)));
      for await (const _ of client.trashNodes([uids.get(name)])) { /* drain */ } uids.delete(name);
      return back.n === payload.n;
    },
  };
}
