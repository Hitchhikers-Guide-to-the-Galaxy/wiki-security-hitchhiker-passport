'use strict'
// Phase 1, checkpoint 9: the farm session door, from pi5:~/scratch/farm-session-test/matrix.sh
// and matrix2.sh. One cookie jar plays the browser; Domain=private.fish cookies travel between
// sites as they do in Chrome. Expected results are the tables on the Farm Sign-In Plan.
const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const { loadModule, makeFarm, Jar, ownerFile, user, farmCookie, farmPayload } = require('./helpers/farm')

const S = 'scratch-farm-secret-not-live'
let mod
before(async () => { mod = await loadModule() })

const owner = (farm, host, jar) => farm.request(host, '/auth/client-settings.json', { jar }).then(r => (r.json().isOwner ? 'owner' : 'not-owner'))
const write = (farm, host, jar) => farm.request(host, '/page/door-test/action', { method: 'PUT', jar, form: { action: '{"type":"create"}' } }).then(r => r.status)
const api = (farm, host, jar) => farm.request(host, '/system/api/farm/assets/upload.json?folder=door-test&name=t.txt', { method: 'POST', jar, body: 'door test', headers: { 'Content-Type': 'application/octet-stream' } }).then(r => r.status)
const whoami = (farm, host, jar) => farm.request(host, '/whoami', { jar }).then(r => r.json())
const farmCookieOf = (jar, domain = 'private.fish', name = 'wikiFarmSession') => jar.get(name, domain)
const decode = c => JSON.parse(Buffer.from(c.value.split('.')[0], 'base64url').toString('utf8'))

describe('matrix.sh: one farm, private.fish', () => {
  let farm
  const jar = new Jar()
  before(async () => {
    farm = await makeFarm(mod.default, {
      'seeded.private.fish': { owner: ownerFile('david', 'David Bovill') },
      'mine.private.fish': { owner: ownerFile('david', 'David Bovill') },
      'mine2.private.fish': { owner: ownerFile('david', 'David Bovill') },
      'theirs.private.fish': { owner: ownerFile('someone', 'Someone Else') },
      'bot.pi5.local': { owner: ownerFile('david', 'David Bovill') },
    }, { cookieSecret: S, farm_session_domain: 'private.fish' })
  })
  after(() => farm.close())

  test('1 nobody signed in: not owner, page write 403, Farm API 403', async () => {
    assert.equal(await owner(farm, 'mine.private.fish', jar), 'not-owner')
    assert.equal(await write(farm, 'mine.private.fish', jar), 403)
    assert.equal(await api(farm, 'mine.private.fish', jar), 403)
    assert.equal(farmCookieOf(jar), null)
  })

  test('2 a real sign-in made on seeded before the switch seeds the farm cookie', async () => {
    farm.signIn(jar, 'seeded.private.fish', 'david')
    const r = await farm.request('seeded.private.fish', '/auth/client-settings.json', { jar })
    assert.equal(r.json().isOwner, true)
    assert.equal(await write(farm, 'seeded.private.fish', jar), 200)
    const sc = r.setCookies.find(c => c.startsWith('wikiFarmSession='))
    assert.ok(sc, 'wikiFarmSession set on the first request of a signed-in user')
    assert.match(sc, /Max-Age=604800/i)
    assert.match(sc, /Domain=private\.fish/i)
    assert.match(sc, /Path=\//i)
    assert.match(sc, /HttpOnly/i)
    assert.match(sc, /SameSite=Lax/i)
    const c = farmCookieOf(jar)
    assert.equal(c.hostOnly, false)
    const p = decode(c)
    assert.equal(p.v, 1)
    assert.deepEqual(p.u, user('david'))
    assert.match(p.jti, /^[0-9a-f]{24}$/)
    assert.ok(p.exp > Date.now() + 6 * 864e5)
  })

  test('3 a new site he owns, never signed in there: owner, 200 / 200, the session adopted the farm cookie', async () => {
    assert.equal(await owner(farm, 'mine.private.fish', jar), 'owner')
    assert.equal(await write(farm, 'mine.private.fish', jar), 200)
    assert.equal(await api(farm, 'mine.private.fish', jar), 200)
    const w = await whoami(farm, 'mine.private.fish', jar)
    assert.deepEqual(w.user, user('david'))
    assert.equal(w.farmSession, decode(farmCookieOf(jar)).jti, 'bound to the cookie that was adopted')
  })

  test('4 a second site he owns', async () => {
    assert.equal(await owner(farm, 'mine2.private.fish', jar), 'owner')
    assert.equal(await write(farm, 'mine2.private.fish', jar), 200)
  })

  test('5 a site someone else owns: adopted identity, but owner.json refuses', async () => {
    assert.equal(await owner(farm, 'theirs.private.fish', jar), 'not-owner')
    assert.equal(await write(farm, 'theirs.private.fish', jar), 403)
    assert.equal(await api(farm, 'theirs.private.fish', jar), 403)
    assert.deepEqual((await whoami(farm, 'theirs.private.fish', jar)).user, user('david'), 'signed in as David there, just not the owner')
  })

  test('6 a host outside private.fish never sees the cookie', async () => {
    assert.equal(await owner(farm, 'bot.pi5.local', jar), 'not-owner')
    assert.equal(await write(farm, 'bot.pi5.local', jar), 403)
  })

  test('7 sign-out on mine leaves a signed-out marker: adopted sessions drop everywhere, the real sign-in stays, nothing re-seeds', async () => {
    const r = await farm.request('mine.private.fish', '/logout', { jar })
    assert.equal(r.text, 'OK')
    const c = farmCookieOf(jar)
    assert.ok(c, 'the farm cookie is still there')
    const p = decode(c)
    assert.equal(p.out, true)
    assert.equal(p.u, undefined)
    assert.equal(await owner(farm, 'mine.private.fish', jar), 'not-owner')
    assert.equal(await write(farm, 'mine.private.fish', jar), 403)
    assert.equal(await owner(farm, 'mine2.private.fish', jar), 'not-owner', 'adopted elsewhere drops too')
    assert.equal(await write(farm, 'mine2.private.fish', jar), 403)
    assert.equal(await owner(farm, 'seeded.private.fish', jar), 'owner', 'the real sign-in on seeded stays, as today')
    assert.equal(await owner(farm, 'mine2.private.fish', jar), 'not-owner', '...but does not re-seed')
    assert.equal(decode(farmCookieOf(jar)).out, true, 'the marker survived the visit to seeded')
  })

  test('8 a fresh sign-in (loginDone after Keycloak) mints a new farm cookie', async () => {
    const r = await farm.request('seeded.private.fish', '/auth/loginDone', { jar })
    assert.equal(r.status, 200)
    assert.ok(r.text.includes('You are now logged in'), 'the done page still renders')
    assert.deepEqual(decode(farmCookieOf(jar)).u, user('david'))
    assert.equal(await owner(farm, 'mine2.private.fish', jar), 'owner')
    assert.equal(await write(farm, 'mine2.private.fish', jar), 200)
  })

  for (const [kind, make] of [
    ['tampered', () => { const v = farmCookie(S, 'private.fish', farmPayload('david')); const last = v.slice(-1); return v.slice(0, -1) + (last === 'A' ? 'B' : 'A') }],
    ['foreign (another farm secret)', () => farmCookie('some-other-farm-secret', 'private.fish', farmPayload('david'))],
    ['expired', () => farmCookie(S, 'private.fish', farmPayload('david', -1000))],
    ['wrong version', () => farmCookie(S, 'private.fish', farmPayload('david', 600000, { v: 2 }))],
    ['signed for another domain', () => farmCookie(S, 'secret.fish', farmPayload('david'))],
    ['not a cookie value at all', () => 'garbage'],
  ]) {
    test(`9 a ${kind} farm cookie is ignored`, async () => {
      const j = new Jar()
      j.set('mine.private.fish', 'wikiFarmSession', make(), 'private.fish')
      assert.equal(await owner(farm, 'mine.private.fish', j), 'not-owner')
      assert.equal(await write(farm, 'mine.private.fish', j), 403)
      assert.equal((await whoami(farm, 'mine.private.fish', j)).user, '')
    })
  }

  test('10 a valid farm cookie for someone else: refused on mine, accepted on their own site', async () => {
    const j = new Jar()
    j.set('mine.private.fish', 'wikiFarmSession', farmCookie(S, 'private.fish', farmPayload('someone')), 'private.fish')
    assert.equal(await owner(farm, 'mine.private.fish', j), 'not-owner')
    assert.equal(await write(farm, 'mine.private.fish', j), 403)
    assert.equal(await owner(farm, 'theirs.private.fish', j), 'owner')
    assert.equal(await write(farm, 'theirs.private.fish', j), 200)
  })

  test('an adopted session dies with the farm cookie it came from', async () => {
    const j = new Jar()
    farm.signIn(j, 'seeded.private.fish', 'david')
    await owner(farm, 'seeded.private.fish', j)
    assert.equal(await owner(farm, 'mine.private.fish', j), 'owner')
    j.cookies.delete('wikiFarmSession|private.fish|false')
    assert.equal(await owner(farm, 'mine.private.fish', j), 'not-owner', 'the per-site session that adopted it is reset')
    assert.equal(await owner(farm, 'seeded.private.fish', j), 'owner', 'the real one is untouched')
  })

  test('a real sign-in on a site that had adopted replaces the adopted one and is no longer bound to the farm cookie', async () => {
    const j = new Jar()
    farm.signIn(j, 'seeded.private.fish', 'david')
    await owner(farm, 'seeded.private.fish', j)
    assert.equal((await whoami(farm, 'mine.private.fish', j)).farmSession !== null, true, 'adopted')
    farm.signIn(j, 'mine.private.fish', 'david')
    const w = await whoami(farm, 'mine.private.fish', j)
    assert.deepEqual(w.user, user('david'))
    assert.equal(w.farmSession, null, 'the adopted marker is dropped')
  })

  test('a farm cookie that would exceed 3000 characters is not set', async () => {
    const j = new Jar()
    j.set('seeded.private.fish', 'wikiSession', require('./helpers/farm').sessionCookie(S, { passport: { user: { oauth2: { id: 'david', username: 'david', displayName: 'x'.repeat(3000) } } } }))
    assert.equal(await owner(farm, 'seeded.private.fish', j), 'owner')
    assert.equal(farmCookieOf(j), null)
  })
})

describe('no switch, no change', () => {
  let farm
  before(async () => {
    farm = await makeFarm(mod.default, {
      'seeded.private.fish': { owner: ownerFile('david') },
      'mine.private.fish': { owner: ownerFile('david') },
    }, { cookieSecret: S })
  })
  after(() => farm.close())

  test('without farm_session_domain a sign-in on one site sets no farm cookie and reaches no other site', async () => {
    const jar = new Jar()
    farm.signIn(jar, 'seeded.private.fish', 'david')
    assert.equal(await owner(farm, 'seeded.private.fish', jar), 'owner')
    assert.equal(farmCookieOf(jar), null)
    assert.equal(await owner(farm, 'mine.private.fish', jar), 'not-owner')
    assert.equal(await write(farm, 'mine.private.fish', jar), 403)
    const r = await farm.request('seeded.private.fish', '/auth/loginDone', { jar })
    assert.equal(r.setCookies.find(c => c.startsWith('wikiFarmSession=')), undefined)
    const planted = new Jar()
    planted.set('mine.private.fish', 'wikiFarmSession', farmCookie(S, 'private.fish', farmPayload('david')), 'private.fish')
    assert.equal(await owner(farm, 'mine.private.fish', planted), 'not-owner', 'a planted farm cookie means nothing to a farm with the door off')
  })
})

describe('matrix2.sh: two farms, one secret, the domain list, secret.fish and the cookie across farms', () => {
  let A, Bown, Bshared
  const jar = new Jar()
  before(async () => {
    const david = { owner: ownerFile('david', 'David Bovill') }
    A = await makeFarm(mod.default, {
      'seeded.private.fish': david, 'mine.private.fish': david,
      'seeded.secret.fish': david, 'mine.secret.fish': david,
      'theirs.secret.fish': { owner: ownerFile('someone', 'Someone Else') },
    }, { cookieSecret: S, farm_session_domain: ['private.fish', 'secret.fish'] })
    // a Pi4-like farm with its own cookie name on its own domain
    Bown = await makeFarm(mod.default, { 'seeded.pi4.private.fish': david, 'mine.pi4.private.fish': david },
      { cookieSecret: S, farm_session_domain: 'pi4.private.fish', farm_session_cookie: 'wikiFarmSessionPi4' })
    // a Mini-like farm sharing the one cookie, the Phase 6 decision
    Bshared = await makeFarm(mod.default, { 'seeded.mini.private.fish': david, 'mine.mini.private.fish': david, 'matt.mini.private.fish': { owner: ownerFile('matt', 'Matt') } },
      { cookieSecret: S, farm_session_domain: 'private.fish' })
  })
  after(async () => { await A.close(); await Bown.close(); await Bshared.close() })

  test('1 signed in on seeded.private.fish: one cookie, for .private.fish', async () => {
    A.signIn(jar, 'seeded.private.fish', 'david')
    await owner(A, 'seeded.private.fish', jar)
    assert.deepEqual(jar.names().filter(n => n.startsWith('wikiFarm')), ['wikiFarmSession@.private.fish'])
  })

  test('2 a new private.fish site is his', async () => {
    assert.equal(await owner(A, 'mine.private.fish', jar), 'owner')
    assert.equal(await write(A, 'mine.private.fish', jar), 200)
  })

  test('3 a secret.fish site needs its own one sign-in', async () => {
    assert.equal(await owner(A, 'mine.secret.fish', jar), 'not-owner')
    assert.equal(await write(A, 'mine.secret.fish', jar), 403)
  })

  test('4 after one sign-in on seeded.secret.fish every secret.fish site he owns knows him; someone else\'s refuses', async () => {
    A.signIn(jar, 'seeded.secret.fish', 'david')
    await owner(A, 'seeded.secret.fish', jar)
    assert.equal(await owner(A, 'mine.secret.fish', jar), 'owner')
    assert.equal(await write(A, 'mine.secret.fish', jar), 200)
    assert.equal(await owner(A, 'theirs.secret.fish', jar), 'not-owner')
    assert.equal(await write(A, 'theirs.secret.fish', jar), 403)
    assert.deepEqual(jar.names().filter(n => n.startsWith('wikiFarm')), ['wikiFarmSession@.private.fish', 'wikiFarmSession@.secret.fish'])
    assert.notEqual(farmCookieOf(jar, 'private.fish').value.split('.')[1], farmCookieOf(jar, 'secret.fish').value.split('.')[1], 'each domain has its own key')
  })

  test('5 sign-out on mine.secret.fish: secret.fish drops, private.fish is not touched', async () => {
    await A.request('mine.secret.fish', '/logout', { jar })
    assert.equal(await owner(A, 'mine.secret.fish', jar), 'not-owner')
    assert.equal(await owner(A, 'mine.private.fish', jar), 'owner')
  })

  test('6 a farm with its own cookie name ignores the Pi5 cookie, though the browser sends it', async () => {
    assert.ok(jar.header('mine.pi4.private.fish').includes('wikiFarmSession='), 'Domain=private.fish reaches *.pi4.private.fish')
    assert.equal(await owner(Bown, 'mine.pi4.private.fish', jar), 'not-owner')
    assert.equal(await write(Bown, 'mine.pi4.private.fish', jar), 403)
  })

  test('7 after one sign-in on that farm its own cookie reaches its sites, and the first farm is unaffected', async () => {
    Bown.signIn(jar, 'seeded.pi4.private.fish', 'david')
    await owner(Bown, 'seeded.pi4.private.fish', jar)
    assert.equal(await owner(Bown, 'mine.pi4.private.fish', jar), 'owner')
    assert.equal(await write(Bown, 'mine.pi4.private.fish', jar), 200)
    assert.equal(await owner(A, 'mine.private.fish', jar), 'owner')
    assert.equal(await write(A, 'mine.private.fish', jar), 200)
    assert.deepEqual(jar.names().filter(n => n.startsWith('wikiFarm')).sort(), ['wikiFarmSession@.private.fish', 'wikiFarmSession@.secret.fish', 'wikiFarmSessionPi4@.pi4.private.fish'])
  })

  test('8 one shared cookie name on the same domain reaches across farms: a Pi5 sign-in is the author on the Mini', async () => {
    const j = new Jar()
    A.signIn(j, 'seeded.private.fish', 'david')
    await owner(A, 'seeded.private.fish', j)
    assert.equal(await owner(Bshared, 'mine.mini.private.fish', j), 'owner')
    assert.equal(await api(Bshared, 'mine.mini.private.fish', j), 200)
    assert.equal(await owner(Bshared, 'matt.mini.private.fish', j), 'not-owner')
    assert.equal(await api(Bshared, 'matt.mini.private.fish', j), 403)
  })

  test('9 a cookie made the v1 way (one domain, default name) still opens the door', async () => {
    const j = new Jar()
    j.set('mine.private.fish', 'wikiFarmSession', farmCookie(S, 'private.fish', farmPayload('david')), 'private.fish')
    assert.equal(await owner(A, 'mine.private.fish', j), 'owner')
    assert.equal(await write(A, 'mine.private.fish', j), 200)
  })

  test('the domain list also parses a comma string with spaces, case and a leading dot', async () => {
    const f = await makeFarm(mod.default, { 'seeded.private.fish': { owner: ownerFile('david') }, 'mine.secret.fish': { owner: ownerFile('david') } },
      { cookieSecret: S, farm_session_domain: ' .Private.FISH, secret.fish ' })
    const j = new Jar()
    f.signIn(j, 'seeded.private.fish', 'david')
    await owner(f, 'seeded.private.fish', j)
    assert.ok(farmCookieOf(j, 'private.fish'))
    j.set('mine.secret.fish', 'wikiFarmSession', farmCookie(S, 'secret.fish', farmPayload('david')), 'secret.fish')
    assert.equal(await owner(f, 'mine.secret.fish', j), 'owner')
    await f.close()
  })

  test('the longest configured domain wins for a host inside two of them', async () => {
    const f = await makeFarm(mod.default, { 'x.pi4.private.fish': { owner: ownerFile('david') } },
      { cookieSecret: S, farm_session_domain: ['private.fish', 'pi4.private.fish'] })
    const j = new Jar()
    f.signIn(j, 'x.pi4.private.fish', 'david')
    const r = await f.request('x.pi4.private.fish', '/auth/client-settings.json', { jar: j })
    assert.match(r.setCookies.find(c => c.startsWith('wikiFarmSession=')), /Domain=pi4\.private\.fish/i)
    await f.close()
  })
})
