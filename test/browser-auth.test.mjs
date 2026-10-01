import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, createBrowserAuth } from '../server/browser-auth.mjs';

const password = 'correct horse battery staple';
const passwordHash = await hashPassword(password, { salt: Buffer.alloc(16, 7) });
const rotatedPasswordHash = await hashPassword(password, { salt: Buffer.alloc(16, 8) });
const sessionSecret = 'test-session-secret-0123456789abcdef';
const cookiePair = token => `sm64_browser_session=${token}`;
const statusIs = status => error => error?.status === status;

test('browser login returns a stable signed session cookie and logout revokes it', async () => {
  const auth = createBrowserAuth({ passwordHash, sessionSecret });
  assert.equal(auth.enabled, true);

  const { token, session } = await auth.login(password, '  Blue   Falcon\u202e ', '127.0.0.1');
  assert.equal(session.authKind, 'browser');
  assert.match(session.userId, /^browser_[A-Za-z0-9_-]{22}$/);
  assert.equal(session.name, 'Blue Falcon');
  assert.equal(session.authExpires - Date.now() > 29 * 24 * 60 * 60 * 1000, true);

  const cookie = auth.cookie(token);
  assert.match(cookie, /^sm64_browser_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /Max-Age=259[0-9]{4}/);
  assert.doesNotMatch(cookie, new RegExp(password));
  assert.equal(auth.authenticate(`theme=dark; ${cookiePair(token)}`).userId, session.userId);
  assert.equal(auth.verifySession({ ...session, name: 'Lobby display name' }), true);

  assert.equal(auth.logout(`theme=dark; ${cookiePair(token)}`), true);
  assert.equal(auth.authenticate(cookiePair(token)), null);
  assert.throws(() => auth.verifySession(session), statusIs(401));
  assert.match(auth.clearCookie(), /Max-Age=0/);
  assert.match(auth.clearCookie(), /; Secure/);
});

test('signed cookies survive an auth instance restart and password hash rotation invalidates them', async () => {
  const first = createBrowserAuth({ passwordHash, sessionSecret });
  const { token, session } = await first.login(password, 'Pilot', 'first-browser');

  const restarted = createBrowserAuth({ passwordHash, sessionSecret });
  const resumed = restarted.authenticate(cookiePair(token));
  assert.equal(resumed.userId, session.userId);
  assert.equal(resumed.sessionId, session.sessionId);
  assert.equal(restarted.verifySession(resumed), true);

  const rotated = createBrowserAuth({ passwordHash: rotatedPasswordHash, sessionSecret });
  assert.equal(rotated.authenticate(cookiePair(token)), null);
});

test('password attempts are rate limited per client and scrypt work has a concurrency bound', async () => {
  const auth = createBrowserAuth({ passwordHash, sessionSecret });
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(auth.login('wrong password', 'Pilot', 'same-client'), statusIs(401));
  }
  await assert.rejects(auth.login(password, 'Pilot', 'same-client'), statusIs(429));
  assert.equal((await auth.login(password, 'Pilot', 'another-client')).session.authKind, 'browser');

  const work = Array.from({ length: 4 }, () => auth.login('wrong password', 'Pilot', 'parallel-client'));
  await assert.rejects(auth.login(password, 'Pilot', 'parallel-client'), statusIs(429));
  const results = await Promise.allSettled(work);
  assert.equal(results.every(result => result.status === 'rejected' && result.reason.status === 401), true);
});

test('tampering, duplicate cookies, expiry, and malformed hash configuration fail closed', async () => {
  let now = Date.UTC(2026, 0, 1);
  const auth = createBrowserAuth({ passwordHash, sessionSecret, secureCookies: false, now: () => now });
  const { token, session } = await auth.login(password, 'Pilot', 'browser');
  const changed = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');

  assert.equal(auth.authenticate(cookiePair(changed)), null);
  assert.equal(auth.authenticate(`${cookiePair(token)}; ${cookiePair(token)}`), null);
  assert.equal(auth.authenticate('x'.repeat(9000)), null);
  assert.doesNotMatch(auth.cookie(token), /; Secure/);
  assert.equal(auth.cookie(token).includes(password), false);
  await assert.rejects(auth.login('x'.repeat(2048), 'Pilot', 'browser'), statusIs(400));
  await assert.rejects(auth.login(password, 'Pilot', 'c'.repeat(129)), statusIs(400));

  now += 30 * 24 * 60 * 60 * 1000 + 1000;
  assert.equal(auth.authenticate(cookiePair(token)), null);
  assert.throws(() => auth.verifySession(session), statusIs(401));

  const disabled = createBrowserAuth({ passwordHash: 'scrypt$invalid', sessionSecret });
  assert.equal(disabled.enabled, false);
  await assert.rejects(disabled.login(password, 'Pilot', 'browser'), statusIs(503));
});
