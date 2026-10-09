// shared/admin-check.mjs: a request is an admin's only if Supabase says so about the
// session token it carries. Run with `npm run test:functions`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdminRequest, SUPABASE_URL } from '../../shared/admin-check.mjs';

const JWT = 'aaaa.bbbb.cccc';
const request = (authorization) => new Request('https://x.test/api/y', { headers: authorization ? { Authorization: authorization } : {} });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A stand-in Supabase: `users` maps token -> user id; `profiles` maps user id -> row.
function supabase({ users = {}, profiles = {}, down = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    if (down) throw new TypeError('fetch failed');
    const token = /Bearer (\S+)/.exec(init.headers.Authorization)?.[1];
    if (String(url).startsWith(`${SUPABASE_URL}/auth/v1/user`)) return users[token] ? json({ id: users[token] }) : json({ msg: 'bad jwt' }, 401);
    const id = new URL(url).searchParams.get('id')?.replace(/^eq\./, '');
    return json(profiles[id] ? [profiles[id]] : []);
  };
  return { fetchImpl, calls };
}

test('a signed-in user whose profile is_admin is an admin', async () => {
  const { fetchImpl, calls } = supabase({ users: { [JWT]: 'u1' }, profiles: { u1: { is_admin: true } } });
  assert.equal(await isAdminRequest(request(`Bearer ${JWT}`), fetchImpl), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.headers.Authorization === `Bearer ${JWT}` && c.headers.apikey), 'both asks are made as that user');
});

test('a signed-in user who is not an admin is not', async () => {
  for (const profile of [{ is_admin: false }, { is_admin: null }, {}, { is_admin: 'true' }]) {
    const { fetchImpl } = supabase({ users: { [JWT]: 'u1' }, profiles: { u1: profile } });
    assert.equal(await isAdminRequest(request(`Bearer ${JWT}`), fetchImpl), false, JSON.stringify(profile));
  }
});

test('no token, a malformed one, or a forged one is not an admin, and asks Supabase nothing when there is no token', async () => {
  const { fetchImpl, calls } = supabase({ users: { [JWT]: 'u1' }, profiles: { u1: { is_admin: true } } });
  assert.equal(await isAdminRequest(request(null), fetchImpl), false);
  assert.equal(await isAdminRequest(request('Bearer not-a-jwt'), fetchImpl), false);
  assert.equal(await isAdminRequest(request('Basic abc'), fetchImpl), false);
  assert.equal(calls.length, 0);
  assert.equal(await isAdminRequest(request('Bearer xxxx.yyyy.zzzz'), fetchImpl), false, 'Supabase rejects it');
});

test('a user with no profile row, or two, is not an admin', async () => {
  const none = supabase({ users: { [JWT]: 'u1' }, profiles: {} });
  assert.equal(await isAdminRequest(request(`Bearer ${JWT}`), none.fetchImpl), false);
  const two = async (url) => (String(url).includes('/auth/v1/user') ? json({ id: 'u1' }) : json([{ is_admin: true }, { is_admin: true }]));
  assert.equal(await isAdminRequest(request(`Bearer ${JWT}`), two), false);
});

test('an unreachable or misbehaving Supabase fails closed', async () => {
  assert.equal(await isAdminRequest(request(`Bearer ${JWT}`), supabase({ down: true }).fetchImpl), false);
  const garbage = async () => new Response('<html>', { status: 200 });
  assert.equal(await isAdminRequest(request(`Bearer ${JWT}`), garbage), false);
  const serverError = async () => json({}, 500);
  assert.equal(await isAdminRequest(request(`Bearer ${JWT}`), serverError), false);
});
