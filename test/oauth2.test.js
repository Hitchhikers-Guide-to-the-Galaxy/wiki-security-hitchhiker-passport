'use strict'
// Phase 1, checkpoint 7: the OAuth2 verify step with a fake token. IdField, UsernameField and
// DisplayNameField from token, params and profile; the callback URL per host and per
// security_useHttps; two sites sharing one passport.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const passport = require('passport')
const OAuth2Strategy = require('passport-oauth2').Strategy
const { loadModule, makeFarm, ownerFile, fakeJwt } = require('./helpers/farm')

let farm
before(async () => {
  const mod = await loadModule()
  farm = await makeFarm(mod.default, {
    'one.test': { owner: ownerFile('david') },
    'two.test': { owner: ownerFile('david'), argv: { security_useHttps: true, oauth2_UserInfoURL: 'https://auth.example.test/userinfo' } },
    'sub.farm.test': { owner: ownerFile('david'), argv: { wiki_domain: 'farm.test' } },
    'profile.test': { owner: ownerFile('david'), argv: { oauth2_IdField: 'profile.sub', oauth2_UsernameField: 'params.user_id', oauth2_DisplayNameField: 'profile.name' } },
    'defaults.test': { owner: ownerFile('david'), argv: { oauth2_IdField: undefined, oauth2_UsernameField: undefined, oauth2_DisplayNameField: undefined } },
  })
})
after(() => farm.close())

const strategy = host => passport._strategy(host + 'OAuth')
const verify = (host, token, params = {}, profile = {}) => new Promise((ok, bad) => {
  strategy(host)._verify(token, 'refresh-token', params, profile, (err, u) => (err ? bad(err) : ok(u)))
})
const token = fakeJwt({ preferred_username: 'david', name: 'David Bovill', sub: 'uuid-1234' })

test('one strategy per site, named after the callback host, all on the one passport', () => {
  for (const h of ['one.test', 'two.test', 'profile.test']) assert.ok(strategy(h) instanceof OAuth2Strategy, h)
  assert.equal(strategy('sub.farm.test'), undefined, 'a farm site is named after its wiki_domain, not its host')
  assert.ok(strategy('farm.test') instanceof OAuth2Strategy)
})

test('the callback URL is http://<host>/auth/oauth2/callback, https when security_useHttps, the wiki_domain on a farm site', () => {
  assert.equal(strategy('one.test')._callbackURL, 'http://one.test/auth/oauth2/callback')
  assert.equal(strategy('two.test')._callbackURL, 'https://two.test/auth/oauth2/callback')
  assert.equal(strategy('farm.test')._callbackURL, 'http://farm.test/auth/oauth2/callback', 'the public farm signs in at the apex')
})

test('the strategy carries the client id, secret and Keycloak URLs from the config', () => {
  const s = strategy('one.test')
  assert.equal(s._oauth2._clientId, 'wiki')
  assert.equal(s._oauth2._clientSecret, 'not-a-real-secret')
  assert.equal(s._oauth2._authorizeUrl, 'https://auth.example.test/realms/wiki/protocol/openid-connect/auth')
  assert.equal(s._oauth2._accessTokenUrl, 'https://auth.example.test/realms/wiki/protocol/openid-connect/token')
})

test('verify reads IdField, UsernameField and DisplayNameField from the decoded access token', async () => {
  const u = await verify('one.test', token)
  assert.deepEqual(u, { oauth2: { id: 'david', username: 'david', displayName: 'David Bovill' } })
})

test('verify reads from params and profile when the fields say so', async () => {
  const u = await verify('profile.test', token, { user_id: 'from-params' }, { sub: 'from-profile', name: 'Profile Name' })
  assert.deepEqual(u, { oauth2: { id: 'from-profile', username: 'from-params', displayName: 'Profile Name' } })
})

test('with no fields configured every value defaults to params.user_id', async () => {
  const u = await verify('defaults.test', token, { user_id: 'uid-9' })
  assert.deepEqual(u, { oauth2: { id: 'uid-9', username: 'uid-9', displayName: 'uid-9' } })
})

test('a field whose source is unknown yields undefined and an error line, the sign-in still completes (Known Issue)', async () => {
  farm.logs.length = 0
  const mod = await loadModule()
  const odd = await makeFarm(mod.default, { 'odd.test': { owner: ownerFile('david'), argv: { oauth2_IdField: 'cookie.id' } } })
  const u = await verify('odd.test', token)
  assert.equal(u.oauth2.id, undefined)
  assert.equal(u.oauth2.username, 'david')
  assert.ok(farm.logs.some(l => l.startsWith('ERROR *** source of user info not recognised cookie.id')))
  await odd.close()
})

test('a missing user field throws on user.oauth2 inside the callback (Known Issue: noisy and fragile sign-in)', async () => {
  const mod = await loadModule()
  const odd = await makeFarm(mod.default, { 'missing.test': { owner: ownerFile('david'), argv: { oauth2_IdField: 'token.nested.deeper' } } })
  await assert.rejects(() => verify('missing.test', token), /Cannot read properties of undefined/)
  await odd.close()
})

test('a token that is not a JWT throws out of the verify step', async () => {
  await assert.rejects(() => verify('one.test', 'not-a-jwt'), /Invalid token/)
})

test('verify logs the user object on every sign-in (Known Issue: logs the name to the journal)', async () => {
  farm.logs.length = 0
  await verify('one.test', token)
  assert.ok(farm.logs.some(l => l.includes("displayName: 'David Bovill'") || l.includes('David Bovill')), 'console.log user.oauth2')
  assert.ok(farm.logs.some(l => l.startsWith('extractUI ')), 'extractUI debug line')
})

test('userProfile is only replaced when oauth2_UserInfoURL is set, and then on the shared prototype, so every site uses the last one set', async () => {
  // one.test has no UserInfoURL, two.test has: both strategies share OAuth2Strategy.prototype
  assert.equal(strategy('one.test').userProfile, strategy('two.test').userProfile)
  const calls = []
  const s = strategy('one.test')
  s._oauth2._request = (method, url, headers, body, accessToken, cb) => { calls.push([method, url, accessToken]); cb(null, JSON.stringify({ sub: 'x' })) }
  const profile = await new Promise((ok, bad) => s.userProfile('tok', (e, p) => (e ? bad(e) : ok(p))))
  assert.deepEqual(profile, { sub: 'x' })
  assert.deepEqual(calls, [['GET', 'https://auth.example.test/userinfo', 'tok']], 'one.test fetched two.test\'s userinfo URL')
})

test('serializeUser and deserializeUser pass the user through whole, overwritten on the passport singleton', async () => {
  const ser = await new Promise((ok, bad) => passport.serializeUser({ oauth2: { id: 'x' } }, {}, (e, o) => (e ? bad(e) : ok(o))))
  assert.deepEqual(ser, { oauth2: { id: 'x' } })
  const de = await new Promise((ok, bad) => passport.deserializeUser({ oauth2: { id: 'y' } }, {}, (e, o) => (e ? bad(e) : ok(o))))
  assert.deepEqual(de, { oauth2: { id: 'y' } })
})

test('GET /auth/oauth2 redirects to Keycloak with the site\'s callback URL; the callback with no code starts the sign-in again', async () => {
  const r = await farm.request('one.test', '/auth/oauth2')
  assert.equal(r.status, 302)
  const loc = new URL(r.headers.location)
  assert.equal(loc.origin + loc.pathname, 'https://auth.example.test/realms/wiki/protocol/openid-connect/auth')
  assert.equal(loc.searchParams.get('redirect_uri'), 'http://one.test/auth/oauth2/callback')
  assert.equal(loc.searchParams.get('client_id'), 'wiki')
  assert.equal(loc.searchParams.get('response_type'), 'code')
  const two = await farm.request('two.test', '/auth/oauth2')
  assert.equal(new URL(two.headers.location).searchParams.get('redirect_uri'), 'https://two.test/auth/oauth2/callback')
  const cb = await farm.request('one.test', '/auth/oauth2/callback')
  assert.equal(cb.status, 302)
  assert.match(cb.headers.location, /^https:\/\/auth\.example\.test\/realms\/wiki\/protocol\/openid-connect\/auth\?/, 'passport-oauth2 treats no code as the start of a sign-in')
  const bad = await farm.request('one.test', '/auth/oauth2/callback?error=access_denied')
  assert.equal(bad.status, 302)
  assert.equal(bad.headers.location, '/auth/loginDialog', 'a provider error bounces to the dialog')
})

test('the dead strategies are not registered when their keys are absent, and their routes answer 401 (Dead Code)', async () => {
  for (const n of ['Github', 'Twitter', 'Google']) assert.equal(strategy('one.test' + n.toLowerCase()), undefined)
  for (const p of ['/auth/github', '/auth/twitter', '/auth/google']) {
    const r = await farm.request('one.test', p)
    assert.equal(r.status, 401, p + ' has no strategy behind it')
  }
})
