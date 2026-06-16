// Serverless login for shared clinical workstations.
//
// From one PBKDF2 run over (username, password) we derive, via HKDF, two
// independent values:
//   - an auth token: published in js/config.js, safe to expose. Knowing it
//     does not reveal the username, the password, or the encryption key.
//   - an AES-GCM key: kept in memory only, used to encrypt/decrypt all
//     patient data at rest in IndexedDB. It is never stored anywhere.
//
// Locking (manually or via the inactivity timer) drops the key, leaving only
// ciphertext in the browser.

import { APPROVED_ACCESS_TOKENS, PBKDF2_ITERATIONS, AUTO_LOCK_MINUTES } from './config.js';

const PBKDF2_SALT_PREFIX = 'whisper-login:v1:';
const HKDF_SALT = 'whisper-hkdf:v1';
const HKDF_INFO_AUTH = 'auth-token';
const HKDF_INFO_ENC = 'encryption-key';
const USERID_PREFIX = 'whisper-userid:v1:';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'click', 'scroll', 'touchstart', 'pointerdown'];
const LOCK_CHECK_INTERVAL_MS = 10 * 1000;

const textEncoder = new TextEncoder();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

// Derives { authToken, encKey, userId } from credentials. Used both by the
// login flow and by tools/generate-token.html, so the two can never diverge.
export async function deriveCredentials(username, password) {
  const user = normalizeUsername(username);
  if (!user || !password) throw new Error('Username and password are required.');

  const baseKey = await crypto.subtle.importKey(
    'raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const masterBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: textEncoder.encode(PBKDF2_SALT_PREFIX + user),
      iterations: PBKDF2_ITERATIONS,
    },
    baseKey,
    256
  );

  const hkdfKey = await crypto.subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const authBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: textEncoder.encode(HKDF_SALT), info: textEncoder.encode(HKDF_INFO_AUTH) },
    hkdfKey,
    256
  );
  // Non-extractable: the key object can be used but its bytes cannot be read,
  // even from DevTools.
  const encKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: textEncoder.encode(HKDF_SALT), info: textEncoder.encode(HKDF_INFO_ENC) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  // Opaque per-user namespace for IndexedDB records; plaintext usernames are
  // never written to storage.
  const userIdBits = await crypto.subtle.digest('SHA-256', textEncoder.encode(USERID_PREFIX + user));
  const userId = toHex(userIdBits).slice(0, 16);

  return { authToken: toHex(authBits), encKey, userId };
}

// --- Session state (memory only) ---

let session = null; // { userId, username, key }
let lastActivity = Date.now();
let lockCheckTimer = null;
let handlers = { onLock: null, onPrepareLock: null, isBusy: null };
let activityListenersAttached = false;

export function isUnlocked() {
  return session !== null;
}

export function getSession() {
  if (!session) throw new Error('Locked: log in first.');
  return session;
}

export async function login(username, password) {
  const { authToken, encKey, userId } = await deriveCredentials(username, password);
  if (!APPROVED_ACCESS_TOKENS.includes(authToken)) return false;
  session = { userId, username: normalizeUsername(username), key: encKey };
  startAutoLock();
  return true;
}

export function lock() {
  if (!session) return;
  void lockInternal();
}

async function lockInternal() {
  if (!session) return;
  try {
    const prep = handlers.onPrepareLock?.();
    if (prep && typeof prep.then === 'function') await prep;
  } catch (e) {
    console.warn('Pre-lock preparation failed', e);
  }
  if (!session) return;
  session = null;
  stopAutoLock();
  if (handlers.onLock) handlers.onLock();
}

// --- Inactivity auto-lock ---

export function configureAutoLock({ onLock, onPrepareLock, isBusy }) {
  handlers = { onLock: onLock || null, onPrepareLock: onPrepareLock || null, isBusy: isBusy || null };
  if (!activityListenersAttached) {
    const markActivity = () => { lastActivity = Date.now(); };
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, markActivity, { passive: true, capture: true });
    }
    activityListenersAttached = true;
  }
}

function startAutoLock() {
  lastActivity = Date.now();
  stopAutoLock();
  lockCheckTimer = setInterval(() => {
    const idleMs = Date.now() - lastActivity;
    if (idleMs < AUTO_LOCK_MINUTES * 60 * 1000) return;
    if (handlers.isBusy && handlers.isBusy()) {
      lastActivity = Date.now();
      return;
    }
    lock();
  }, LOCK_CHECK_INTERVAL_MS);
}

function stopAutoLock() {
  if (lockCheckTimer) {
    clearInterval(lockCheckTimer);
    lockCheckTimer = null;
  }
}
