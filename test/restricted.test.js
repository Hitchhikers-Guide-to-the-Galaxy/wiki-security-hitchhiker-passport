'use strict'
// Phase 1, checkpoint 8: login-to-view as upstream wrote it, with today's query-string
// bypass kept as a known-bad case that Phase 3 flips.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { loadModule, makeFarm, Jar, ownerFile, sessionCookie } = require('./helpers/farm')

let farm
before(async () => {
  const mod = await loadModule()
  farm = await makeFarm(mod.default, {
    'gate.test': { owner: ownerFile('david'), assets: true, argv: { restricted: 'true', allowed_ids: ['lena'] } },
    'star.test': { owner: ownerFile('david'), argv: { restricted: true, allowed_ids: ['*'] } },
    'unclaimed.test': { argv: { restricted: 'true' } },
    'mail.test': { owner: ownerFile('david'), argv: { restricted: 'true', allowed_domains: ['example.org'] } },
    'open.test': { owner: ownerFile('david') },
  })
})
after(() => farm.close())

const signedAs = (host, id) => { const jar = new Jar(); farm.signIn(jar, host, id); return jar }
const get = (host, p, jar, headers) => farm.request(host, p, { jar, headers })
const isLoginRequired = r => r.status === 200 && r.json().title === 'Login Required'
const isPage = r => r.status === 200 && r.json().story[0].text === 'page body'

test('anonymous page json on a restricted site is the Login Required page, 200, with the details link', async () => {
  const r = await get('gate.test', '/secret-page.json')
  assert.ok(isLoginRequired(r))
  assert.match(r.json().story[0].text, /^This is a restricted wiki requires users to login to view pages\./)
  assert.match(r.json().story[0].text, /\[http:\/\/ward\.asia\.wiki\.org\/login-to-view\.html details\]$/)
})

test('KNOWN BAD, Phase 3 flips it: a query string slips past the gate because it tests req.url', async () => {
  const r = await get('gate.test', '/secret-page.json?x=1')
  assert.ok(isPage(r), 'today the real page is served to anyone')
})

test('KNOWN BAD, Phase 3 flips it: upper case and a trailing slash slip past too', async () => {
  // the gate does not answer; wiki-server's own routes are lower-case and exact, so these 404 today
  assert.equal((await get('gate.test', '/Secret-Page.JSON')).status, 404, 'not gated: the gate did not answer Login Required')
  assert.equal((await get('gate.test', '/secret-page.json/')).status, 404, 'not gated either')
})

test('the owner sees the page; an id in allowed_ids sees it; another id gets Login Required', async () => {
  assert.ok(isPage(await get('gate.test', '/secret-page.json', signedAs('gate.test', 'david'))))
  assert.ok(isPage(await get('gate.test', '/secret-page.json', signedAs('gate.test', 'lena'))))
  assert.ok(isLoginRequired(await get('gate.test', '/secret-page.json', signedAs('gate.test', 'someone'))))
})

test('allowed_ids ["*"] admits any signed-in user, not an anonymous one', async () => {
  assert.ok(isPage(await get('star.test', '/secret-page.json', signedAs('star.test', 'anyone'))))
  assert.ok(isLoginRequired(await get('star.test', '/secret-page.json')))
})

test('a restricted but unclaimed site shows nothing to anyone: isAuthorized is true but owner is empty', async () => {
  assert.ok(isLoginRequired(await get('unclaimed.test', '/secret-page.json')))
  assert.ok(isLoginRequired(await get('unclaimed.test', '/secret-page.json', signedAs('unclaimed.test', 'david'))))
})

test('allowed_domains reads Google emails only, so an oauth2 user never matches (Dead Code)', async () => {
  assert.ok(isLoginRequired(await get('mail.test', '/secret-page.json', signedAs('mail.test', 'someone'))))
  const jar = new Jar()
  jar.set('mail.test', 'wikiSession', sessionCookie('test-cookie-secret', { passport: { user: { google: { id: 'g1', emails: [{ value: 'me@example.org' }] } } } }))
  assert.ok(isPage(await get('mail.test', '/secret-page.json', jar)))
})

test('an html page request redirects to /view/<slug> instead of answering', async () => {
  const r = await get('gate.test', '/secret-page.html')
  assert.equal(r.status, 302)
  assert.equal(r.headers.location, '/view/secret-page')
})

test('/system/sitemap.json answers ["Login Required"]', async () => {
  const r = await get('gate.test', '/system/sitemap.json')
  assert.deepEqual(r.json(), ['Login Required'])
  const ok = await get('gate.test', '/system/sitemap.json', signedAs('gate.test', 'david'))
  assert.equal(ok.json()[0].slug, 'welcome-visitors')
})

test('the site flag and the html view pass the gate', async () => {
  assert.equal((await get('gate.test', '/favicon.png')).status, 200)
  const v = await get('gate.test', '/view/welcome-visitors')
  assert.equal(v.status, 200)
  assert.match(v.text, /view \/view\/welcome-visitors/)
})

test('/auth/client-settings.json answers before the gate, so the client can offer sign-in', async () => {
  const r = await get('gate.test', '/auth/client-settings.json')
  assert.deepEqual(r.json(), { useHttps: false, isOwner: false })
})

test('UPSTREAM GAP (login-gate-files closes it): assets, listings, the xml sitemap and the MCP door are not gated', async () => {
  assert.equal((await get('gate.test', '/assets/secret-folder/copy.txt')).text, 'ASSET BODY')
  assert.equal((await get('gate.test', '/sitemap.xml')).status, 200)
  assert.deepEqual((await get('gate.test', '/plugin/assets/list?assets=secret-folder')).json(), { files: ['copy.txt'] })
  assert.equal((await get('gate.test', '/plugin/assets/index')).status, 200)
  assert.equal((await farm.request('gate.test', '/system/api/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 1, method: 'tools/call' } })).status, 200)
})

test('UPSTREAM LEAK: a missing assets folder answers the fs error with the disk path in it', async () => {
  const r = await get('gate.test', '/plugin/assets/list?assets=nope', signedAs('gate.test', 'david'))
  assert.equal(r.json().error.code, 'ENOENT')
  assert.ok(r.json().error.path.includes(farm.sites['gate.test'].argv.assets))
})

test('the gate reflects any Origin with credentials allowed (Known Issue: credentialed CORS, Phase 4 tests it)', async () => {
  const r = await get('gate.test', '/secret-page.json', null, { Origin: 'https://evil.example' })
  assert.equal(r.headers['access-control-allow-origin'], 'https://evil.example')
  assert.equal(r.headers['access-control-allow-credentials'], 'true')
  const bare = await get('gate.test', '/secret-page.json')
  assert.equal(bare.headers['access-control-allow-origin'], '*')
})

test('a site that is not restricted serves everything anonymously', async () => {
  assert.ok(isPage(await get('open.test', '/secret-page.json')))
  assert.equal((await get('open.test', '/system/sitemap.json')).json()[0].slug, 'welcome-visitors')
  assert.equal((await get('open.test', '/secret-page.html')).status, 200)
})

test('argv.details replaces the details link', async () => {
  const mod = await loadModule()
  const f = await makeFarm(mod.default, { 'd.test': { owner: ownerFile('david'), argv: { restricted: 'true', details: 'https://example.org/why' } } })
  const r = await f.request('d.test', '/x.json')
  assert.match(r.json().story[0].text, /\[https:\/\/example\.org\/why details\]$/)
  await f.close()
})
