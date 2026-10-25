'use strict'
// Test farm: loads the security module the way wiki-server 0.27 does and runs
// one or more sites in one process, each on its own host name, behind the
// same cookieParser + client-sessions stack wiki-server builds. A stand-in
// answers the routes wiki-server would answer after the security routes, so
// login-to-view and the page-write gate can be exercised end to end.
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const util = require('node:util')
const { pathToFileURL } = require('node:url')
const express = require('express')
const cookieParser = require('cookie-parser')
const sessions = require('client-sessions')

const REPO = path.resolve(__dirname, '..', '..')
const MODULE = path.join(REPO, 'index.js')
const noop = () => {}

// ---- the module logs with console.log directly; keep it out of the test output ----
const logs = []
const real = { log: console.log, error: console.error }
console.log = (...a) => { logs.push(util.format(...a)) }
console.error = (...a) => { logs.push('ERROR ' + util.format(...a)) }
process.on('exit', () => { console.log = real.log; console.error = real.error })

// wiki-server 0.27: `const securityModule = await import(argv.security_type)`
// then `securityModule.default(log, loga, argv)`.
async function loadModule(file = MODULE) {
  return import(pathToFileURL(file).href)
}

function fakeJwt(payload) {
  const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  return b64u({ alg: 'RS256', typ: 'JWT' }) + '.' + b64u(payload) + '.signature'
}

// what a Keycloak oauth2 sign-in leaves in req.session.passport.user
function user(id, name) {
  return { oauth2: { id, username: id, displayName: name || id } }
}

// what the real farm writes to status/owner.json when the site is claimed
function ownerFile(id, name) {
  return { name: name || id, oauth2: { id, username: id } }
}

// a wikiSession value as a real sign-in leaves it (client-sessions' own encoding)
function sessionCookie(secret, content, duration = 7 * 864e5) {
  return sessions.util.encode({ cookieName: 'wikiSession', secret }, content, duration)
}

// a wikiFarmSession value as the farm door mints it
function farmCookie(secret, domain, payload) {
  const key = crypto.createHmac('sha256', String(secret)).update('wikiFarmSession:' + domain).digest()
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return body + '.' + crypto.createHmac('sha256', key).update(body).digest('base64url')
}

function farmPayload(id, expOffsetMs = 600000, extra = {}) {
  return { v: 1, u: user(id), jti: 'forged' + crypto.randomBytes(4).toString('hex'), exp: Date.now() + expOffsetMs, ...extra }
}

// ---- a cookie jar that honours Domain, host-only cookies and expiry, like a browser ----
class Jar {
  constructor() { this.cookies = new Map() }
  store(setCookies, host) {
    for (const sc of setCookies) {
      const [nv, ...attrs] = sc.split(';').map(s => s.trim())
      const eq = nv.indexOf('=')
      const name = nv.slice(0, eq), value = nv.slice(eq + 1)
      let domain = null, maxAge = null, expires = null
      const flags = {}
      for (const a of attrs) {
        const i = a.indexOf('=')
        const k = (i < 0 ? a : a.slice(0, i)).toLowerCase(), v = i < 0 ? '' : a.slice(i + 1)
        if (k === 'domain') domain = v.replace(/^\./, '').toLowerCase()
        else if (k === 'max-age') maxAge = Number(v)
        else if (k === 'expires') expires = new Date(v)
        else flags[k] = v
      }
      const hostOnly = !domain
      domain = domain || host.toLowerCase()
      const key = name + '|' + domain + '|' + hostOnly
      const expired = maxAge !== null ? maxAge <= 0 : expires ? expires.getTime() <= Date.now() : false
      if (expired || value === '') this.cookies.delete(key)
      else this.cookies.set(key, { name, value, domain, hostOnly, flags })
    }
  }
  header(host) {
    host = host.toLowerCase()
    const out = []
    for (const c of this.cookies.values()) {
      const match = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain)
      if (match) out.push(c.name + '=' + c.value)
    }
    return out.join('; ')
  }
  // plant a cookie as a browser would hold it: host-only unless domain is given
  set(host, name, value, domain = null) {
    const d = (domain || host).toLowerCase()
    this.cookies.set(name + '|' + d + '|' + !domain, { name, value, domain: d, hostOnly: !domain, flags: {} })
  }
  get(name, domain = null) {
    for (const c of this.cookies.values()) if (c.name === name && (!domain || c.domain === domain)) return c
    return null
  }
  names() { return [...this.cookies.values()].map(c => c.name + '@' + (c.hostOnly ? '' : '.') + c.domain).sort() }
  clear() { this.cookies.clear() }
}

function request(port, host, pathname, o = {}) {
  return new Promise((ok, bad) => {
    const headers = { Host: host, ...(o.headers || {}) }
    if (o.jar) { const c = o.jar.header(host); if (c) headers.Cookie = c }
    let body = o.body
    if (o.json !== undefined) { body = JSON.stringify(o.json); headers['Content-Type'] = 'application/json' }
    if (o.form !== undefined) { body = new URLSearchParams(o.form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded' }
    if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body)
    const req = http.request({ host: '127.0.0.1', port, method: o.method || 'GET', path: pathname, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const setCookies = res.headers['set-cookie'] || []
        if (o.jar) o.jar.store(setCookies, host)
        ok({ status: res.statusCode, headers: res.headers, text, setCookies, json() { return JSON.parse(text) } })
      })
    })
    req.on('error', bad)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

// the argv wiki-server's farm.js hands a site: url from the host, data folder per site
function siteArgv(host, opts = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-' + host.replace(/[^a-z0-9]/gi, '_') + '-'))
  const status = path.join(data, 'status')
  fs.mkdirSync(status, { recursive: true })
  const argv = {
    url: 'http://' + host,
    data, status,
    id: path.join(status, 'owner.json'),
    assets: path.join(data, 'assets'),
    cookieSecret: 'test-cookie-secret',
    session_duration: 7,
    secure_cookie: false,
    security_type: 'wiki-security-hitchhiker-passport',
    oauth2_clientID: 'wiki',
    oauth2_clientSecret: 'not-a-real-secret',
    oauth2_AuthorizationURL: 'https://auth.example.test/realms/wiki/protocol/openid-connect/auth',
    oauth2_TokenURL: 'https://auth.example.test/realms/wiki/protocol/openid-connect/token',
    oauth2_IdField: 'token.preferred_username',
    oauth2_UsernameField: 'token.preferred_username',
    oauth2_DisplayNameField: 'token.name',
    ...(opts.argv || {}),
  }
  if (opts.owner !== undefined) fs.writeFileSync(argv.id, typeof opts.owner === 'string' ? opts.owner : JSON.stringify(opts.owner))
  if (opts.assets) {
    fs.mkdirSync(path.join(argv.assets, 'secret-folder'), { recursive: true })
    fs.writeFileSync(path.join(argv.assets, 'secret-folder', 'copy.txt'), 'ASSET BODY')
  }
  return argv
}

// What wiki-server answers after `securityhandler.defineRoutes(app, cors, updateOwner)`,
// reduced to what the tests look at. /whoami is a test probe and nothing else.
function standIn(req, res, security, getOwner, argv) {
  const p = req.path
  if (p === '/favicon.png') return res.type('png').send(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  if (p === '/whoami') {
    return res.json({
      user: security.getUser(req),
      isOwner: security.isAuthorized(req) ? true : false,
      isAdmin: security.isAdmin(req) ? true : false,
      owner: getOwner(),
      farmSession: req.session.farmSession || null,
    })
  }
  if (p.startsWith('/view/')) return res.type('html').send('<html>view ' + p + '</html>')
  if (p === '/system/sitemap.json') return res.json([{ slug: 'welcome-visitors', title: 'Welcome Visitors' }])
  if (p === '/sitemap.xml') return res.type('xml').send('<urlset>sitemap body</urlset>')
  if (p.startsWith('/assets/')) {
    // express.static(argv.assets): decoded path, case as on disk
    const file = path.join(argv.assets, decodeURIComponent(p.slice('/assets/'.length)))
    if (fs.existsSync(file)) return res.type('text').send(fs.readFileSync(file))
    return res.sendStatus(404)
  }
  if (p === '/plugin/assets/list') {
    // wiki-plugin-assets answers a folder it cannot read with the raw fs error, path included
    const folder = path.join(argv.assets, String(req.query.assets || ''))
    if (!fs.existsSync(folder)) return res.json({ error: { code: 'ENOENT', errno: -2, syscall: 'scandir', path: folder } })
    return res.json({ files: fs.readdirSync(folder) })
  }
  if (p === '/plugin/assets/index') {
    // and its index throws on a site with no assets folder
    if (!fs.existsSync(argv.assets)) throw new Error('ENOENT: no such file or directory, scandir ' + argv.assets)
    return res.json(fs.readdirSync(argv.assets))
  }
  if (p === '/system/api/mcp') return res.json({ jsonrpc: '2.0', id: 1, result: { tools: ['table_list'] } })
  if (p.startsWith('/system/api/farm/')) {
    // wiki-plugin-farm gates its writes on isAuthorized
    if (!security.isAuthorized(req)) return res.sendStatus(403)
    return res.json({ ok: true })
  }
  if (/^\/page\/[^/]+\/action$/.test(p) && req.method === 'PUT') {
    // wiki-server's `authorized` middleware
    if (!security.isAuthorized(req)) return res.sendStatus(403)
    return res.send('ok')
  }
  let m
  if ((m = /^\/([a-z0-9-]+)\.json$/.exec(p))) return res.json({ title: m[1], story: [{ type: 'paragraph', id: 'a1b2c3d4e5f60718', text: 'page body' }] })
  if ((m = /^\/([a-z0-9-]+)\.html$/.exec(p))) return res.type('html').send('<html>page body</html>')
  res.sendStatus(404)
}

async function makeSite(factory, host, opts = {}) {
  const argv = siteArgv(host, opts)
  const security = factory(noop, noop, argv)
  await new Promise((ok, bad) => security.retrieveOwner(e => (e ? bad(e) : ok())))
  let owner = security.getOwner()
  const updateOwner = id => { owner = id }
  const app = express()
  app.set('trust proxy', false)
  app.use(cookieParser())
  app.use(express.json({ limit: '5mb' }))
  app.use(express.urlencoded({ extended: true, limit: '5mb' }))
  const cookieValue = { httpOnly: true, sameSite: 'lax' }
  if (argv.wiki_domain && !argv.wiki_domain.endsWith('localhost')) cookieValue.domain = argv.wiki_domain
  app.use(sessions({
    cookieName: 'wikiSession',
    requestKey: 'session',
    secret: argv.cookieSecret,
    duration: argv.session_duration * 24 * 60 * 60 * 1000,
    activeDuration: 24 * 60 * 60 * 1000,
    cookie: cookieValue,
  }))
  const cors = (req, res, next) => { res.header('Access-Control-Allow-Origin', req.get('origin') || '*'); next() }
  security.defineRoutes(app, cors, updateOwner)
  app.use((req, res) => standIn(req, res, security, () => owner, argv))
  return { host, argv, security, app, get owner() { return owner } }
}

// sites: { host: { owner, assets, argv } }; shared: argv every site gets (the farm config)
async function makeFarm(factory, sites, shared = {}) {
  const apps = {}
  const farm = { port: null, sites: {}, logs }
  for (const [host, so] of Object.entries(sites)) {
    const s = await makeSite(factory, host, { ...so, argv: { ...shared, ...(so.argv || {}) } })
    apps[host] = s.app
    farm.sites[host] = s
  }
  const server = http.createServer((req, res) => {
    const h = (req.headers.host || '').split(':')[0]
    const app = apps[h]
    if (!app) { res.statusCode = 400; return res.end('Requested Wiki Does Not Exist') }
    app(req, res)
  })
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  farm.port = server.address().port
  farm.close = () => new Promise(ok => server.close(ok))
  farm.request = (host, pathname, o) => request(farm.port, host, pathname, o)
  farm.signIn = (jar, host, id) => jar.set(host, 'wikiSession', sessionCookie(farm.sites[host].argv.cookieSecret, { passport: { user: user(id) } }))
  return farm
}

module.exports = { REPO, MODULE, loadModule, makeSite, makeFarm, request, Jar, user, ownerFile, sessionCookie, farmCookie, farmPayload, fakeJwt, logs }
