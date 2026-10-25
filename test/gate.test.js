'use strict'
// Phase 1, checkpoint 10: the gate matrix from pi5:~/scratch/gate-test/matrix.sh, run against
// the module as the Pi5 private farm patches it (login-gate-query-bypass + login-gate-files
// with assets-list-error-scrub). Rows anon / other user / allowed user / owner.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { makeFarm, Jar, ownerFile } = require('./helpers/farm')
const { patchedModule, patchedSource } = require('./helpers/patched')

let farm
before(async () => {
  const factory = patchedModule()
  farm = await makeFarm(factory, {
    'gate.test': { owner: ownerFile('david'), assets: true, argv: { restricted: 'true', allowed_ids: ['lena'] } },
    'noassets.test': { owner: ownerFile('david'), argv: { restricted: 'true' } },
    'open.test': { owner: ownerFile('david'), assets: true },
  })
})
after(() => farm.close())

const rows = {
  anon: () => undefined,
  other: () => { const j = new Jar(); farm.signIn(j, 'gate.test', 'someone'); return j },
  lena: () => { const j = new Jar(); farm.signIn(j, 'gate.test', 'lena'); return j },
  david: () => { const j = new Jar(); farm.signIn(j, 'gate.test', 'david'); return j },
}
const get = (p, who = 'anon', host = 'gate.test') => farm.request(host, p, { jar: rows[who] ? rows[who]() : undefined })
const tag = r => {
  if (r.status === 403 && r.text === 'Login Required') return '403:LR'
  if (r.status === 200 && /"title":"Login Required"/.test(r.text)) return '200:LR'
  if (r.status === 200 && r.text === '["Login Required"]') return '200:LR'
  if (r.text.includes('ASSET BODY')) return `${r.status}:ASSET`
  if (r.text.includes('page body')) return `${r.status}:PAGE`
  return `${r.status}:${r.text.slice(0, 12).replace(/\s+/g, ' ')}`
}

test('the patched source carries both patches', () => {
  const src = patchedSource()
  assert.ok(src.includes("/\\.(json|html)\\/?$/i.test req.path"))
  assert.ok(src.includes('gatedFiles = /^\\/(assets|plugin\\/assets|system\\/api\\/mcp|sitemap\\.xml)(\\/|$)/i'))
  assert.ok(src.includes('assets-list-error-scrub'))
  assert.ok(!src.includes('/\\.(json|html)$/.test req.url'), 'the req.url test is gone')
})

test('page json: Login Required for anon and another user, the page for the allowed id and the owner', async () => {
  assert.equal(tag(await get('/secret-page.json', 'anon')), '200:LR')
  assert.equal(tag(await get('/secret-page.json', 'other')), '200:LR')
  assert.equal(tag(await get('/secret-page.json', 'lena')), '200:PAGE')
  assert.equal(tag(await get('/secret-page.json', 'david')), '200:PAGE')
})

test('FLIPPED from upstream: a query string no longer slips past the gate', async () => {
  assert.equal(tag(await get('/secret-page.json?x=1', 'anon')), '200:LR')
  assert.equal(tag(await get('/secret-page.json?x=1', 'other')), '200:LR')
  assert.equal(tag(await get('/secret-page.json?x=1', 'david')), '200:PAGE')
})

test('FLIPPED from upstream: upper case and a trailing slash are gated', async () => {
  assert.equal(tag(await get('/Secret-Page.JSON', 'anon')), '200:LR')
  assert.equal(tag(await get('/secret-page.json/', 'anon')), '200:LR')
  // the html redirect still matches lower-case .html only, so an upper-case .HTML gets the Login Required json instead
  assert.equal(tag(await get('/secret-page.HTML', 'anon')), '200:LR')
  assert.equal((await get('/secret-page.html', 'anon')).headers.location, '/view/secret-page')
})

test('/system/sitemap.json answers ["Login Required"], with a trailing slash too', async () => {
  assert.equal(tag(await get('/system/sitemap.json', 'anon')), '200:LR')
  assert.equal(tag(await get('/system/sitemap.json/', 'anon')), '200:LR')
  assert.equal(tag(await get('/system/sitemap.json?x=1', 'anon')), '200:LR')
  assert.equal((await get('/system/sitemap.json', 'david')).json()[0].slug, 'welcome-visitors')
})

test('the xml sitemap: 403 Login Required anonymously, served to the allowed and the owner', async () => {
  assert.equal(tag(await get('/sitemap.xml', 'anon')), '403:LR')
  assert.equal(tag(await get('/sitemap.xml', 'other')), '403:LR')
  assert.equal((await get('/sitemap.xml', 'lena')).status, 200)
  assert.equal((await get('/sitemap.xml', 'david')).status, 200)
})

test('assets: 403 Login Required anonymously, in upper case, percent-encoded and with a doubled slash', async () => {
  for (const p of ['/assets/secret-folder/copy.txt', '/ASSETS/secret-folder/copy.txt', '/%61ssets/secret-folder/copy.txt', '//assets/secret-folder/copy.txt', '/assets/', '/assets']) {
    assert.equal(tag(await get(p, 'anon')), '403:LR', p)
    assert.equal(tag(await get(p, 'other')), '403:LR', p)
  }
  assert.equal(tag(await get('/assets/secret-folder/copy.txt', 'lena')), '200:ASSET')
  assert.equal(tag(await get('/assets/secret-folder/copy.txt', 'david')), '200:ASSET')
})

test('the assets plugin listings: 403 anonymously; the owner gets the list, and a missing folder answers the error code only', async () => {
  assert.equal(tag(await get('/plugin/assets/list?assets=secret-folder', 'anon')), '403:LR')
  assert.equal(tag(await get('/plugin/assets/index', 'anon')), '403:LR')
  assert.deepEqual((await get('/plugin/assets/list?assets=secret-folder', 'david')).json(), { files: ['copy.txt'] })
  const missing = (await get('/plugin/assets/list?assets=nope', 'david')).json()
  assert.deepEqual(missing, { error: { code: 'ENOENT' } }, 'no disk path in the answer')
  assert.deepEqual((await get('/plugin/assets/index', 'david')).json(), ['secret-folder'])
})

test('a site with no assets folder: the index answers [] instead of a stack trace, to anyone, since the scrub sits before the gate', async () => {
  assert.equal(tag(await get('/plugin/assets/index', 'anon', 'noassets.test')), '200:[]')
  const j = new Jar(); farm.signIn(j, 'noassets.test', 'david')
  const r = await farm.request('noassets.test', '/plugin/assets/index', { jar: j })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json(), [])
})

test('the MCP door: 403 anonymously, open to the owner', async () => {
  const post = jar => farm.request('gate.test', '/system/api/mcp', { method: 'POST', jar, json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'table_list', arguments: {} } } })
  assert.equal(tag(await post(undefined)), '403:LR')
  assert.equal(tag(await post(rows.other())), '403:LR')
  assert.equal((await post(rows.david())).status, 200)
  assert.equal((await post(rows.david())).json().result.tools[0], 'table_list')
})

test('the site flag, the html view and client-settings still pass anonymously', async () => {
  assert.equal((await get('/favicon.png', 'anon')).status, 200)
  assert.equal((await get('/view/welcome-visitors', 'anon')).status, 200)
  assert.deepEqual((await get('/auth/client-settings.json', 'anon')).json(), { useHttps: false, isOwner: false })
  assert.equal((await get('/auth/loginDialog', 'anon')).status, 200)
})

test('an open site is untouched by the gate, and the scrub applies there too', async () => {
  assert.equal(tag(await get('/secret-page.json', 'anon', 'open.test')), '200:PAGE')
  assert.equal(tag(await get('/secret-page.json?x=1', 'anon', 'open.test')), '200:PAGE')
  assert.equal(tag(await get('/assets/secret-folder/copy.txt', 'anon', 'open.test')), '200:ASSET')
  assert.equal((await get('/sitemap.xml', 'anon', 'open.test')).status, 200)
  assert.deepEqual((await get('/plugin/assets/list?assets=nope', 'anon', 'open.test')).json(), { error: { code: 'ENOENT' } })
  assert.deepEqual((await get('/plugin/assets/index', 'anon', 'open.test')).json(), ['secret-folder'])
})

test('the whole matrix, as matrix.sh printed it', async () => {
  const paths = ['/secret-page.json', '/secret-page.json?x=1', '/system/sitemap.json', '/sitemap.xml', '/assets/secret-folder/copy.txt', '/ASSETS/secret-folder/copy.txt', '/%61ssets/secret-folder/copy.txt', '//assets/secret-folder/copy.txt', '/plugin/assets/list?assets=secret-folder', '/plugin/assets/list?assets=nope', '/plugin/assets/index', '/favicon.png', '/view/welcome-visitors', '/auth/client-settings.json']
  const table = {}
  for (const p of paths) {
    table[p] = {}
    for (const who of ['anon', 'other', 'david']) table[p][who] = tag(await get(p, who))
  }
  const anon = Object.fromEntries(paths.map(p => [p, table[p].anon]))
  assert.deepEqual(anon, {
    '/secret-page.json': '200:LR', '/secret-page.json?x=1': '200:LR', '/system/sitemap.json': '200:LR',
    '/sitemap.xml': '403:LR', '/assets/secret-folder/copy.txt': '403:LR', '/ASSETS/secret-folder/copy.txt': '403:LR',
    '/%61ssets/secret-folder/copy.txt': '403:LR', '//assets/secret-folder/copy.txt': '403:LR',
    '/plugin/assets/list?assets=secret-folder': '403:LR', '/plugin/assets/list?assets=nope': '403:LR', '/plugin/assets/index': '403:LR',
    '/favicon.png': '200:�PNG', '/view/welcome-visitors': '200:<html>view /', '/auth/client-settings.json': '200:{"useHttps":',
  })
  for (const p of paths) assert.equal(table[p].other, table[p].anon, 'another signed-in user is treated like anon: ' + p)
  for (const p of paths) assert.ok(!table[p].david.includes('LR'), 'the owner is never refused: ' + p)
})
