import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'sm64_browser_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_BYTES = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 1024;
const MAX_COOKIE_HEADER = 8192;
const MAX_TOKEN_BYTES = 4096;
const MAX_ACTIVE_SESSIONS = 4096;
const MAX_REVOKED_SESSIONS = 4096;
const MAX_TRACKED_CLIENTS = 2048;
const MAX_CLIENT_ATTEMPTS = 5;
const CLIENT_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_GLOBAL_ATTEMPTS = 60;
const GLOBAL_ATTEMPT_WINDOW_MS = 60 * 1000;
const MAX_CONCURRENT_CHECKS = 4;

export class BrowserAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'BrowserAuthError';
    this.status = status;
  }
}

function passwordBytes(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_BYTES ||
      Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new BrowserAuthError('Invalid password input', 400);
  }
  return Buffer.from(password, 'utf8');
}

function decodeBase64Url(value, expectedBytes = null) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || (expectedBytes !== null && bytes.length !== expectedBytes)) return null;
  return bytes;
}

function scryptAsync(password, salt, keyLength) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Create a BROWSER_PASSWORD_HASH value suitable for the server environment. */
export async function hashPassword(password, { salt = randomBytes(16) } = {}) {
  const value = passwordBytes(password);
  const saltBytes = Buffer.isBuffer(salt) ? Buffer.from(salt) : Buffer.from(salt);
  if (saltBytes.length < 16 || saltBytes.length > 32) throw new TypeError('Password hash salt must be 16 to 32 bytes');
  const digest = await scryptAsync(value, saltBytes, SCRYPT_BYTES);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltBytes.toString('base64url')}$${digest.toString('base64url')}`;
}

function parsePasswordHash(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== String(SCRYPT_N) ||
      parts[2] !== String(SCRYPT_R) || parts[3] !== String(SCRYPT_P)) return null;
  const salt = decodeBase64Url(parts[4]);
  const digest = decodeBase64Url(parts[5], SCRYPT_BYTES);
  if (!salt || salt.length < 16 || salt.length > 32 || !digest) return null;
  return { salt, digest };
}

function sanitizeName(value) {
  if (typeof value !== 'string') return 'Player';
  const cleaned = value.slice(0, 512)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const limited = Array.from(cleaned).slice(0, 32).join('');
  return limited || 'Player';
}

function readCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length > MAX_COOKIE_HEADER) return null;
  let found = null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found && found.length <= MAX_TOKEN_BYTES ? found : null;
}

export function createBrowserAuth({ passwordHash, sessionSecret, secureCookies = true, now = Date.now } = {}) {
  const parsedHash = parsePasswordHash(passwordHash);
  const secret = typeof sessionSecret === 'string' && Buffer.byteLength(sessionSecret, 'utf8') >= 32 &&
    Buffer.byteLength(sessionSecret, 'utf8') <= 4096 ? Buffer.from(sessionSecret, 'utf8') : null;
  const enabled = Boolean(parsedHash && secret);
  const signingKey = enabled ? createHmac('sha256', secret).update('sm64-browser-session\0').update(passwordHash).digest() : null;
  const activeSessions = new Map();
  const revokedSessions = new Map();
  const clientAttempts = new Map();
  const globalAttempts = [];
  let activeChecks = 0;
  let sessionEpoch = 0;

  const currentTime = () => {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
  };

  function prune(nowMs) {
    for (const [sessionId, session] of activeSessions) {
      if (session.authExpires <= nowMs) activeSessions.delete(sessionId);
    }
    for (const [sessionId, expiry] of revokedSessions) {
      if (expiry <= nowMs) revokedSessions.delete(sessionId);
    }
    for (const [clientKey, attempt] of clientAttempts) {
      if (attempt.windowStart + CLIENT_ATTEMPT_WINDOW_MS <= nowMs) clientAttempts.delete(clientKey);
    }
    while (globalAttempts.length && globalAttempts[0] <= nowMs - GLOBAL_ATTEMPT_WINDOW_MS) globalAttempts.shift();
  }

  function signature(payloadPart) {
    return createHmac('sha256', signingKey).update(payloadPart).digest();
  }

  function decodeToken(token, nowMs = currentTime()) {
    if (!enabled || typeof token !== 'string' || token.length > MAX_TOKEN_BYTES || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    const separator = token.indexOf('.');
    const payloadPart = token.slice(0, separator);
    const signaturePart = decodeBase64Url(token.slice(separator + 1), 32);
    if (!signaturePart) return null;
    const expected = signature(payloadPart);
    if (!timingSafeEqual(signaturePart, expected)) return null;
    const payloadBytes = decodeBase64Url(payloadPart);
    if (!payloadBytes || payloadBytes.length > 2048) return null;
    let claims;
    try { claims = JSON.parse(payloadBytes.toString('utf8')); } catch { return null; }
    const nowSeconds = Math.floor(nowMs / 1000);
    if (!claims || claims.v !== 1 || !Number.isSafeInteger(claims.epoch) ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
        claims.exp - claims.iat !== SESSION_TTL_SECONDS || claims.iat > nowSeconds + 60 || claims.exp <= nowSeconds ||
        typeof claims.uid !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(claims.uid) ||
        typeof claims.sid !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(claims.sid) ||
        typeof claims.name !== 'string' || claims.name.length > 128 || sanitizeName(claims.name) !== claims.name) return null;
    return claims;
  }

  function sessionFrom(claims) {
    return {
      authKind: 'browser',
      userId: `browser_${claims.uid}`,
      name: claims.name,
      sessionId: claims.sid,
      authExpires: claims.exp * 1000,
      authEpoch: claims.epoch,
    };
  }

  function storeSession(claims, nowMs) {
    prune(nowMs);
    if (claims.epoch !== sessionEpoch || revokedSessions.has(claims.sid)) return null;
    let session = activeSessions.get(claims.sid);
    if (session) return session;
    if (activeSessions.size >= MAX_ACTIVE_SESSIONS) return null;
    session = sessionFrom(claims);
    activeSessions.set(claims.sid, session);
    return session;
  }

  function makeToken(claims) {
    const payloadPart = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const signaturePart = signature(payloadPart).toString('base64url');
    return `${payloadPart}.${signaturePart}`;
  }

  function normalizeClientKey(value) {
    if (value === undefined || value === null || value === '') return 'unknown';
    if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new BrowserAuthError('Invalid sign-in request', 400);
    }
    return value;
  }

  function reserveAttempt(clientKey, nowMs) {
    prune(nowMs);
    if (activeChecks >= MAX_CONCURRENT_CHECKS || globalAttempts.length >= MAX_GLOBAL_ATTEMPTS) {
      throw new BrowserAuthError('Too many sign-in attempts. Try again later.', 429);
    }
    let attempt = clientAttempts.get(clientKey);
    if (attempt && attempt.windowStart + CLIENT_ATTEMPT_WINDOW_MS <= nowMs) {
      clientAttempts.delete(clientKey);
      attempt = null;
    }
    if (attempt && attempt.count >= MAX_CLIENT_ATTEMPTS) {
      throw new BrowserAuthError('Too many sign-in attempts. Try again later.', 429);
    }
    if (!attempt) {
      if (clientAttempts.size >= MAX_TRACKED_CLIENTS) {
        const oldestKey = clientAttempts.keys().next().value;
        if (oldestKey !== undefined) clientAttempts.delete(oldestKey);
      }
      attempt = { count: 0, windowStart: nowMs };
      clientAttempts.set(clientKey, attempt);
    }
    attempt.count++;
    globalAttempts.push(nowMs);
    activeChecks++;
  }

  function cookie(token) {
    const nowMs = currentTime();
    const claims = decodeToken(token, nowMs);
    if (!claims || claims.epoch !== sessionEpoch) throw new BrowserAuthError('Invalid browser session', 400);
    const maxAge = Math.max(0, claims.exp - Math.floor(nowMs / 1000));
    const expires = new Date(claims.exp * 1000).toUTCString();
    return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; Expires=${expires}; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`;
  }

  function clearCookie() {
    return `${COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`;
  }

  async function login(password, name, clientKey) {
    if (!enabled) throw new BrowserAuthError('Browser sign-in is not configured', 503);
    const passwordValue = passwordBytes(password);
    const safeClientKey = normalizeClientKey(clientKey);
    const nowMs = currentTime();
    reserveAttempt(safeClientKey, nowMs);
    try {
      const actual = await scryptAsync(passwordValue, parsedHash.salt, SCRYPT_BYTES);
      if (!timingSafeEqual(actual, parsedHash.digest)) throw new BrowserAuthError('Invalid password', 401);

      const nowSeconds = Math.floor(currentTime() / 1000);
      const claims = {
        v: 1,
        epoch: sessionEpoch,
        uid: randomBytes(16).toString('base64url'),
        sid: randomBytes(16).toString('base64url'),
        name: sanitizeName(name),
        iat: nowSeconds,
        exp: nowSeconds + SESSION_TTL_SECONDS,
      };
      const session = storeSession(claims, currentTime());
      if (!session) throw new BrowserAuthError('Browser sign-in capacity is full', 429);
      clientAttempts.delete(safeClientKey);
      return { token: makeToken(claims), session };
    } finally {
      activeChecks--;
    }
  }

  function authenticate(cookieHeader) {
    const token = readCookie(cookieHeader);
    if (!token) return null;
    const nowMs = currentTime();
    const claims = decodeToken(token, nowMs);
    if (!claims || claims.epoch !== sessionEpoch) return null;
    return storeSession(claims, nowMs);
  }

  function logout(cookieHeader) {
    const token = readCookie(cookieHeader);
    if (!token) return false;
    const nowMs = currentTime();
    const claims = decodeToken(token, nowMs);
    if (!claims) return false;
    prune(nowMs);
    if (claims.epoch !== sessionEpoch) return true;
    if (!revokedSessions.has(claims.sid) && revokedSessions.size >= MAX_REVOKED_SESSIONS) {
      // Keep the revocation store bounded and fail closed if it reaches capacity.
      sessionEpoch++;
      revokedSessions.clear();
      activeSessions.clear();
      return true;
    }
    revokedSessions.set(claims.sid, claims.exp * 1000);
    activeSessions.delete(claims.sid);
    return true;
  }

  function verifySession(session) {
    const nowMs = currentTime();
    prune(nowMs);
    if (!session || session.authKind !== 'browser' || typeof session.sessionId !== 'string' ||
        session.authEpoch !== sessionEpoch || session.authExpires <= nowMs || revokedSessions.has(session.sessionId)) {
      throw new BrowserAuthError('Browser session has expired or been revoked', 401);
    }
    const active = activeSessions.get(session.sessionId);
    if (!active || active.userId !== session.userId ||
        active.authExpires !== session.authExpires || active.authEpoch !== session.authEpoch) {
      throw new BrowserAuthError('Browser session has expired or been revoked', 401);
    }
    return true;
  }

  return { enabled, login, authenticate, logout, cookie, clearCookie, verifySession };
}
