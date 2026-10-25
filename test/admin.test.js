'use strict'
// Phase 1, checkpoint 5: isAdmin. No admin false, matching id true, other id false, provider missing from admin false.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { loadModule, makeFarm, Jar, ownerFile, sessionCookie } = require('./helpers/farm')

let farm
before(async () => {
  const mod = await loadModule()
  farm = await makeFarm(mod.default, {
    'noadmin.test': { owner: ownerFile('david') },
    'admin.test': { owner: ownerFile('someone'), argv: { admin: { oauth2: 'david' } } },
    'hubadmin.test': { owner: ownerFile('someone'), argv: { admin: { github: '42' } } },
  })
})
after(() => farm.close())

const whoami = (host, jar) => farm.request(host, '/whoami', { jar }).then(r => r.json())
const signedAs = (host, id) => { const jar = new Jar(); farm.signIn(jar, host, id); return jar }
const withUser = (host, u) => { const jar = new Jar(); jar.set(host, 'wikiSession', sessionCookie('test-cookie-secret', { passport: { user: u } })); return jar }

test('no admin in the config: nobody is admin, not even the owner', async () => {
  assert.equal((await whoami('noadmin.test', signedAs('noadmin.test', 'david'))).isAdmin, false)
})

test('the configured oauth2 id is admin, on a site someone else owns', async () => {
  const w = await whoami('admin.test', signedAs('admin.test', 'david'))
  assert.equal(w.isAdmin, true)
  assert.equal(w.isOwner, false, 'admin is not owner')
})

test('another id is not admin', async () => {
  assert.equal((await whoami('admin.test', signedAs('admin.test', 'someone'))).isAdmin, false)
})

test('nobody signed in is not admin', async () => {
  assert.equal((await whoami('admin.test', new Jar())).isAdmin, false)
})

test('a provider missing from admin is not admin, and says so in the log', async () => {
  farm.logs.length = 0
  assert.equal((await whoami('hubadmin.test', signedAs('hubadmin.test', '42'))).isAdmin, false)
  assert.ok(farm.logs.includes('admin not defined for  oauth2'))
  assert.equal((await whoami('hubadmin.test', withUser('hubadmin.test', { github: { id: '42' } }))).isAdmin, true)
})

test('a provider the module does not know is not admin', async () => {
  assert.equal((await whoami('admin.test', withUser('admin.test', { facebook: { id: 'david' } }))).isAdmin, false)
})

test('admin compares the whole configured value with the id: a number does not match the string', async () => {
  assert.equal((await whoami('hubadmin.test', withUser('hubadmin.test', { github: { id: 42 } }))).isAdmin, false)
})
