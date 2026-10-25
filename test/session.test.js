'use strict'
// Phase 1, checkpoint 3: the session. getUser reads req.session.passport.user; /logout resets the session.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { loadModule, makeFarm, Jar, ownerFile, user, sessionCookie } = require('./helpers/farm')

let farm
before(async () => {
  const mod = await loadModule()
  farm = await makeFarm(mod.default, { 'alpha.test': { owner: ownerFile('david', 'David Bovill') } })
})
after(() => farm.close())

const whoami = jar => farm.request('alpha.test', '/whoami', { jar }).then(r => r.json())

test('getUser is the empty string with no session user', async () => {
  assert.equal((await whoami(new Jar())).user, '')
})

test('getUser returns req.session.passport.user whole, as the sign-in stored it', async () => {
  const jar = new Jar()
  farm.signIn(jar, 'alpha.test', 'david')
  assert.deepEqual((await whoami(jar)).user, user('david'))
})

test('getUser is the empty string when session.passport exists but has no user', async () => {
  const jar = new Jar()
  jar.set('alpha.test', 'wikiSession', sessionCookie('test-cookie-secret', { passport: {} }))
  assert.equal((await whoami(jar)).user, '')
})

test('a cookie signed with another secret is not a session', async () => {
  const jar = new Jar()
  jar.set('alpha.test', 'wikiSession', sessionCookie('some-other-secret', { passport: { user: user('david') } }))
  assert.equal((await whoami(jar)).user, '')
})

test('an expired cookie is not a session', async () => {
  const jar = new Jar()
  jar.set('alpha.test', 'wikiSession', sessionCookie('test-cookie-secret', { passport: { user: user('david') } }, -1000))
  assert.equal((await whoami(jar)).user, '')
})

test('/logout answers OK, resets the session and the user is gone on the next request', async () => {
  const jar = new Jar()
  farm.signIn(jar, 'alpha.test', 'david')
  assert.equal((await whoami(jar)).user.oauth2.id, 'david')
  const r = await farm.request('alpha.test', '/logout', { jar })
  assert.equal(r.status, 200)
  assert.equal(r.text, 'OK')
  assert.ok(r.setCookies.some(c => c.startsWith('wikiSession=')), 'the reset session is written back')
  assert.equal((await whoami(jar)).user, '')
  assert.ok(farm.logs.includes('Logout...'), 'logs Logout...')
})

test('/logout on a fresh browser is harmless', async () => {
  const r = await farm.request('alpha.test', '/logout', { jar: new Jar() })
  assert.equal(r.status, 200)
  assert.equal(r.text, 'OK')
})

test('/auth/diag reports the user and answers the date; today it also rebinds wikiName (known-odd)', async () => {
  const jar = new Jar()
  farm.signIn(jar, 'alpha.test', 'david')
  farm.logs.length = 0
  const r = await farm.request('alpha.test', '/auth/diag', { jar })
  assert.equal(r.status, 200)
  assert.ok(!Number.isNaN(Date.parse(r.json())), 'a date string')
  assert.ok(farm.logs.some(l => l.startsWith('SOCIAL *** ') && l.includes('"id":"david"')), 'logs the identity')
})
