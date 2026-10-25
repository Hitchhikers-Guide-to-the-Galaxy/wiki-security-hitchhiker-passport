'use strict'
// The module as the Pi5 private farm runs it: server/social.coffee with the two
// login-gate patches pi5:~/wiki-patches/apply.py re-applies on every start
// (login-gate-query-bypass, login-gate-files with assets-list-error-scrub).
// test/pi5-patches.json is a snapshot of those two entries, taken 2026-10-25.
// The patched copy is written under test/.patched (ignored by git) and loaded
// through coffeescript/register as index.js loads the real one.
const fs = require('node:fs')
const path = require('node:path')
const { REPO } = require('./farm')

function patchedSource() {
  const patches = require('../pi5-patches.json')
  let src = fs.readFileSync(path.join(REPO, 'server', 'social.coffee'), 'utf8')
  for (const p of patches) {
    if (!src.includes(p.old)) throw new Error(`patch ${p.name}: old text not found`)
    src = src.replace(p.old, () => p.new)
    for (const [old, neu, mark] of p.also || []) {
      if (!src.includes(old)) throw new Error(`patch ${p.name}: also-old text not found`)
      src = src.replace(old, () => neu)
      if (!src.includes(mark)) throw new Error(`patch ${p.name}: also-marker ${mark} missing after patch`)
    }
    if (!src.includes(p.marker)) throw new Error(`patch ${p.name}: marker missing after patch`)
  }
  return src
}

function patchedModule() {
  const dir = path.join(REPO, 'test', '.patched')
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'server', 'social.coffee'), patchedSource())
  const views = path.join(dir, 'views')
  if (!fs.existsSync(views)) fs.symlinkSync(path.join('..', '..', 'views'), views)
  require('coffeescript')
  require('coffeescript/register')
  return require(path.join(dir, 'server', 'social.coffee'))
}

module.exports = { patchedSource, patchedModule }
