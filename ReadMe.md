# wiki-security-hitchhiker-passport

**Upstream `wiki-security-passportjs`, unmodified, plus the hitchhiker client bootstrap.**

The federated wiki page loads exactly one script unconditionally after `client.js`:
`/security/security.js`, from whichever security module `security_type` names. That
makes the security module the only farm-wide client injection point. This package is
passportjs — the OAuth module the Keycloak login needs — with a short block appended to
`client/security.js` that loads:

- `/plugins/hitchhiker/wiki-ux.js` — the house UX layer (`wiki-plugin-hitchhiker`)

These are optional at runtime — if a plugin is not installed the `<script>` 404s and
nothing else breaks — but a 404 is logged as two console errors on every page of every
site in the farm, so only list plugins that are actually installed.

`/plugins/terms/wiki-terms.js` (`wiki-plugin-terms`, the terms fork interceptor) was
listed in 0.14.0-hitchhiker.2 and removed in `.3`: the plugin is unpublished and was
never installed. Re-add it in the release that installs it.

## The rules this fork keeps

1. **Append, never edit.** Everything above the marker comment in `client/security.js`
   is upstream, byte for byte. Everything below is the block.
2. **Server untouched.** `server/social.coffee`, `views/`, `index.js` are upstream's.
   OAuth is not modified.
3. **Both bootstraps.** A farm moving from the friends-fork must not silently lose one.
4. **Track the upstream version.** `package.json` → `hitchhiker.upstreamVersion`.

## To re-fork on a new upstream release

    UP=$(npm root -g)/wiki/node_modules/wiki-security-passportjs   # or the new tarball
    rsync -a --exclude node_modules --exclude client/security.js "$UP/" .
    # then: copy the new upstream client/security.js over ours, and re-append
    # everything from the marker comment down (keep a copy of that block first)
    # bump version to <upstream>-hitchhiker.N and set hitchhiker.upstreamVersion

## Use

Farm config: `"security_type": "hitchhiker-passport"` (wiki-server prefixes `wiki-security-`).
Install into the wiki's package directory — derive it, do not type it:

    W=$(npm root -g)/wiki
    npm install --prefix "$W" wiki-security-hitchhiker-passport

then restart the farm. Login is unchanged. Keycloak redirect URIs are unaffected.

Forked 2026-08-18 from wiki-security-passportjs 0.14.0. Rationale and the options
rejected: plugin.fedwiki.club → Loading the UX Layer.
