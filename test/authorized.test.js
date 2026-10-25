'use strict'
// Phase 1, checkpoint 4: isAuthorized. Unclaimed true, matching owner id true, other id false,
// unknown provider false, an unparsable owner file false.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { loadModule, makeFarm, Jar, ownerFile, sessionCookie } = require('./helpers/farm')

let farm
before(async () => {
  const mod = await loadModule()
  farm = await makeFarm(mod.default, {
    'unclaimed.test': {},
    'mine.test': { owner: ownerFile('david', 'David Bovill') },
    'broken.test': { owner: '{ not json' },
    'github.test': { owner: { name: 'Hub', github: { id: '42', username: 'hub' } } },
  })
})
after(() => farm.close())

const whoami = (host, jar) => farm.request(host, '/whoami', { jar }).then(r => r.json())
const signedAs = (host, id) => { const jar = new Jar(); farm.signIn(jar, host, id); return jar }
const withUser = (host, u) => { const jar = new Jar(); jar.set(host, 'wikiSession', sessionCookie('test-cookie-secret', { passport: { user: u } })); return jar }

test('an unclaimed site authorises everyone, signed in or not (Known Issue: unclaimed sites are writable)', async () => {
  assert.equal((await whoami('unclaimed.test', new Jar())).isOwner, true)
  assert.equal((await whoami('unclaimed.test', signedAs('unclaimed.test', 'anyone'))).isOwner, true)
  const w = await farm.request('unclaimed.test', '/page/x/action', { method: 'PUT', form: { action: '{}' } })
  assert.equal(w.status, 200, 'a page write is accepted with no session at all')
  assert.ok(farm.logs.includes('isAuthorized: site not claimed'))
})

test('getOwner is the empty string on an unclaimed site and the name from owner.json otherwise', () => {
  assert.equal(farm.sites['unclaimed.test'].security.getOwner(), '')
  assert.equal(farm.sites['mine.test'].security.getOwner(), 'David Bovill')
})

test('the matching oauth2 id is the owner', async () => {
  assert.equal((await whoami('mine.test', signedAs('mine.test', 'david'))).isOwner, true)
})

test('another oauth2 id is not', async () => {
  assert.equal((await whoami('mine.test', signedAs('mine.test', 'someone'))).isOwner, false)
})

test('nobody signed in is not, and a page write is refused 403', async () => {
  assert.equal((await whoami('mine.test', new Jar())).isOwner, false)
  const w = await farm.request('mine.test', '/page/x/action', { method: 'PUT', form: { action: '{}' } })
  assert.equal(w.status, 403)
})

test('a provider the module does not know is not', async () => {
  assert.equal((await whoami('mine.test', withUser('mine.test', { facebook: { id: 'david' } }))).isOwner, false)
})

test('a known provider that is not the one in owner.json is not', async () => {
  assert.equal((await whoami('mine.test', withUser('mine.test', { github: { id: 'david' } }))).isOwner, false)
  assert.equal((await whoami('github.test', signedAs('github.test', '42'))).isOwner, false, 'oauth2 id 42 against a github owner')
  assert.equal((await whoami('github.test', withUser('github.test', { github: { id: '42' } }))).isOwner, true, 'the github id matches')
})

test('the comparison is deep equality on the id, so the string "42" and the number 42 differ', async () => {
  assert.equal((await whoami('github.test', withUser('github.test', { github: { id: 42 } }))).isOwner, false)
})

test('an unparsable owner file makes the site claimed by nobody: owner is unparsable, every request refused', async () => {
  assert.equal(farm.sites['broken.test'].security.getOwner(), 'unparsable')
  assert.equal((await whoami('broken.test', new Jar())).isOwner, false)
  assert.equal((await whoami('broken.test', signedAs('broken.test', 'david'))).isOwner, false)
  assert.ok(farm.logs.some(l => l.startsWith('ERROR Error parsing owner file')))
})

test('isAuthorized logs the idProvider on every request of a signed-in user (Known Issue: noisy)', async () => {
  farm.logs.length = 0
  await whoami('mine.test', signedAs('mine.test', 'david'))
  assert.ok(farm.logs.includes('idProvider:  oauth2'))
})

test('setOwner writes owner.json once and refuses a second claim', async () => {
  const s = farm.sites['unclaimed.test'].security
  const id = ownerFile('david', 'David Bovill')
  await new Promise((ok, bad) => s.setOwner(id, e => (e ? bad(e) : ok())))
  assert.equal(s.getOwner(), 'David Bovill')
  const again = await new Promise(ok => s.setOwner(ownerFile('someone'), e => ok(e)))
  assert.equal(again, 'Already Claimed')
  assert.equal((await whoami('unclaimed.test', signedAs('unclaimed.test', 'someone'))).isOwner, false, 'claimed now, so others are refused')
  assert.ok(farm.logs.some(l => l.startsWith('Claiming wiki http://unclaimed.test for David Bovill')))
})
