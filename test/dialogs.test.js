'use strict'
// Phase 1, checkpoint 6: /auth/client-settings.json, the login dialog and the done page.
// isOwner, wikiHost, the wikiName cookie or host fallback, the line break.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { loadModule, makeFarm, Jar, ownerFile } = require('./helpers/farm')

let farm
before(async () => {
  const mod = await loadModule()
  farm = await makeFarm(mod.default, {
    'mine.test': { owner: ownerFile('david', 'David Bovill') },
    'unclaimed.test': {},
    // a public-farm site: wikiDomains gives it wiki_domain, so cookies and the dialog name the farm
    'sub.farm.test': { owner: ownerFile('david', 'David Bovill'), argv: { wiki_domain: 'farm.test' } },
    'tls.test': { owner: ownerFile('david', 'David Bovill'), argv: { security_useHttps: true } },
  })
})
after(() => farm.close())

const signedAs = (host, id) => { const jar = new Jar(); farm.signIn(jar, host, id); return jar }
const settings = (host, jar) => farm.request(host, '/auth/client-settings.json', { jar }).then(r => r.json())

test('client-settings: useHttps false, no wikiHost, isOwner false for a stranger', async () => {
  assert.deepEqual(await settings('mine.test', new Jar()), { useHttps: false, isOwner: false })
})

test('client-settings: isOwner true for the owner, false for another id', async () => {
  assert.equal((await settings('mine.test', signedAs('mine.test', 'david'))).isOwner, true)
  assert.equal((await settings('mine.test', signedAs('mine.test', 'someone'))).isOwner, false)
})

test('client-settings: an unclaimed site reports isOwner false even though isAuthorized is true', async () => {
  assert.equal((await settings('unclaimed.test', signedAs('unclaimed.test', 'david'))).isOwner, false)
  assert.equal((await settings('unclaimed.test', new Jar())).isOwner, false)
})

test('client-settings: wikiHost is the wiki_domain on a farm site, and useHttps follows security_useHttps', async () => {
  assert.deepEqual(await settings('sub.farm.test', new Jar()), { useHttps: false, wikiHost: 'farm.test', isOwner: false })
  assert.equal((await settings('tls.test', new Jar())).useHttps, true)
})

test('a farm site with wiki_domain sets its session cookie with Domain=<wiki_domain>', async () => {
  const r = await farm.request('sub.farm.test', '/logout', { jar: new Jar() })
  const sc = r.setCookies.find(c => c.startsWith('wikiSession='))
  assert.match(sc, /domain=farm\.test/i)
})

test('login dialog: names the host when there is no wikiName cookie, offers OAuth2 only, says a federated wiki site', async () => {
  const r = await farm.request('mine.test', '/auth/loginDialog')
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /text\/html/)
  assert.ok(r.text.includes('<h2 id=wiki_name>mine.test</h2>'), 'host as the wiki name')
  assert.ok(r.text.includes('src="//mine.test/favicon.png"'), 'flag from the host')
  assert.ok(r.text.includes('<h3 id="wiki_hostname">a federated wiki site</h3>'))
  assert.ok(r.text.includes('<title>Federated Wiki: Site Owner Sign-on</title>'))
  assert.ok(r.text.includes('<h2>Sign in to mine.test with...</h2>'))
  assert.ok(r.text.includes("href='/auth/oauth2'"), 'the OAuth2 button')
  assert.ok(!r.text.includes("href='/auth/github'") && !r.text.includes("href='/auth/twitter'") && !r.text.includes('/auth/google'), 'no other schemes configured')
  assert.ok(r.text.includes('window.resizeBy(0, +300)'), 'the popup grows for Keycloak')
})

test('login dialog: the wikiName cookie wins over the host (the wiki-client sets it to the site name)', async () => {
  const r = await farm.request('mine.test', '/auth/loginDialog', { headers: { Cookie: 'wikiName=my.pretty.name' } })
  assert.ok(r.text.includes('<h2 id=wiki_name>my.pretty.name</h2>'))
  assert.ok(r.text.includes('src="//my.pretty.name/favicon.png"'))
})

test('login dialog on a farm site says part of <host> wiki farm', async () => {
  const r = await farm.request('sub.farm.test', '/auth/loginDialog')
  assert.ok(r.text.includes('<h3 id="wiki_hostname">part of sub.farm.test wiki farm</h3>'))
})

test('done page: the line break in the message renders (triple-stash), title says owner sign-on on a claimed site', async () => {
  const r = await farm.request('mine.test', '/auth/loginDone', { jar: signedAs('mine.test', 'david') })
  assert.equal(r.status, 200)
  assert.ok(r.text.includes("<p>You are now logged in<br>If this window hasn't closed, you can close it.</p>"), 'the <br> is not escaped')
  assert.ok(!r.text.includes('&lt;br&gt;'))
  assert.ok(r.text.includes('<title>Wiki Site Owner Sign-on</title>'))
  assert.ok(r.text.includes('<h2 id=wiki_name>mine.test</h2>'))
  assert.ok(r.text.includes('document.cookie = "state=loggedIn"'), 'the done page tells the opener')
  assert.ok(r.text.includes('<script src="/security/winchan.js"></script>'))
})

test('done page: on an unclaimed site the title invites a claim; the wikiName cookie names it', async () => {
  const r = await farm.request('unclaimed.test', '/auth/loginDone', { headers: { Cookie: 'wikiName=fresh.site' } })
  assert.ok(r.text.includes('<title>Sign-on to claim Wiki site</title>'))
  assert.ok(r.text.includes('<h2 id=wiki_name>fresh.site</h2>'))
})

test('addAuthDialog: 403 signed out; signed in it offers nothing, since only oauth2 is configured', async () => {
  const out = await farm.request('mine.test', '/auth/addAuthDialog')
  assert.equal(out.status, 403)
  const r = await farm.request('mine.test', '/auth/addAuthDialog', { jar: signedAs('mine.test', 'david') })
  assert.equal(r.status, 200)
  assert.ok(r.text.includes('Add Alternative Authentication Scheme'))
  assert.ok(!r.text.includes('scheme-button'), 'no alternative schemes offered')
})

test('claim-wiki: a signed-in user claims an unclaimed site and owner.json names them; a second claim is 403', async () => {
  const site = farm.sites['unclaimed.test']
  const r = await farm.request('unclaimed.test', '/auth/claim-wiki', { jar: signedAs('unclaimed.test', 'david') })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json(), { ownerName: 'david' })
  assert.deepEqual(JSON.parse(require('node:fs').readFileSync(site.argv.id, 'utf8')), { name: 'david', oauth2: { id: 'david', username: 'david' } })
  assert.equal(site.owner, 'david', 'updateOwner told wiki-server')
  const again = await farm.request('unclaimed.test', '/auth/claim-wiki', { jar: signedAs('unclaimed.test', 'someone') })
  assert.equal(again.status, 403)
})

test('claim-wiki with nobody signed in throws inside the route (Known Issue: fragile), answered as a 500', async () => {
  const r = await farm.request('mine.test', '/auth/claim-wiki')
  assert.equal(r.status, 403, 'a claimed site refuses first')
  const unclaimed = await makeFreshUnclaimed()
  const r2 = await unclaimed.request('fresh.test', '/auth/claim-wiki')
  assert.equal(r2.status, 500)
  await unclaimed.close()
})

async function makeFreshUnclaimed() {
  const mod = await loadModule()
  return makeFarm(mod.default, { 'fresh.test': {} })
}
