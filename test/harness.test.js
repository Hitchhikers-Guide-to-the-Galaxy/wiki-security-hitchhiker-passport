'use strict'
// Phase 1, checkpoint 2: the module loads as wiki-server 0.27 loads it and runs
// two sites in one process behind express 5 + client-sessions.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { loadModule, makeFarm, Jar, ownerFile } = require('./helpers/farm')

let mod, farm
before(async () => {
  mod = await loadModule()
  farm = await makeFarm(mod.default, {
    'alpha.test': { owner: ownerFile('david', 'David Bovill') },
    'beta.test': { owner: ownerFile('someone', 'Someone Else') },
  })
})
after(() => farm.close())

test('await import() of the package yields a default export that is the factory, as wiki-server 0.27 expects', () => {
  assert.equal(typeof mod.default, 'function')
  assert.equal(mod.default.length, 3, 'factory takes (log, loga, argv)')
})

test('the factory returns the handler wiki-server calls', () => {
  const s = farm.sites['alpha.test'].security
  for (const f of ['retrieveOwner', 'getOwner', 'setOwner', 'getUser', 'isAuthorized', 'isAdmin', 'login', 'logout', 'defineRoutes']) {
    assert.equal(typeof s[f], 'function', f)
  }
  assert.equal(s.defineRoutes.length, 3, 'defineRoutes takes (app, cors, updateOwner)')
})

test('the stack is express 5 with client-sessions and cookie-parser, the versions the farms run', () => {
  assert.match(require('express/package.json').version, /^5\./)
  assert.match(require('client-sessions/package.json').version, /^0\.8\./)
  assert.match(require('cookie-parser/package.json').version, /^1\.4\./)
})

test('two sites answer in one process, each by its own host name', async () => {
  const a = await farm.request('alpha.test', '/whoami')
  const b = await farm.request('beta.test', '/whoami')
  assert.equal(a.status, 200)
  assert.equal(a.json().owner, 'David Bovill')
  assert.equal(b.json().owner, 'Someone Else')
  const none = await farm.request('gamma.test', '/whoami')
  assert.equal(none.status, 400)
})

test('a plain read sets no cookie; a session write leaves wikiSession, httpOnly and SameSite=Lax, host-only when the site has no wiki_domain', async () => {
  const jar = new Jar()
  const read = await farm.request('alpha.test', '/whoami', { jar })
  assert.equal(read.setCookies.find(c => c.startsWith('wikiSession=')), undefined, 'client-sessions writes the cookie only when the session changed')
  const r = await farm.request('alpha.test', '/logout', { jar })
  const sc = r.setCookies.find(c => c.startsWith('wikiSession='))
  assert.ok(sc, 'wikiSession set')
  assert.match(sc, /httponly/i)
  assert.match(sc, /samesite=lax/i)
  assert.doesNotMatch(sc, /domain=/i)
  assert.equal(jar.get('wikiSession').hostOnly, true)
})

test('a forged sign-in on one site is not seen by the other: sessions are per host', async () => {
  const jar = new Jar()
  farm.signIn(jar, 'alpha.test', 'david')
  const a = await farm.request('alpha.test', '/whoami', { jar })
  const b = await farm.request('beta.test', '/whoami', { jar })
  assert.deepEqual(a.json().user, { oauth2: { id: 'david', username: 'david', displayName: 'david' } })
  assert.equal(b.json().user, '')
})

test('the module serves nothing itself at /security; wiki-server mounts the client folder', async () => {
  const r = await farm.request('alpha.test', '/security/security.js')
  assert.equal(r.status, 404)
})
