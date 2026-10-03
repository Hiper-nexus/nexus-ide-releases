# http-cache-semantics 4.2.0 security build (4.2.1-nexus.1)

This directory temporarily packages `http-cache-semantics@4.2.0`
(BSD-2-Clause, Copyright 2016-2018 Kornel Lesiński) with two minimal Nexus
security patches. It is a Nexus build, not an upstream 4.2.1 release; the
`-nexus.1` prerelease suffix keeps that visible in the lockfile and SBOM.

In Nexus, http-cache-semantics is only reached by the build toolchain
(`got`/`cacheable-request` under `@electron-forge/maker-zip` and
`make-fetch-happen` under `@electron/node-gyp`); it is not part of the
packaged app. Both consumers decide cache hits through
`satisfiesWithoutRevalidation()`.

## Patch 1: `max-stale` cannot reuse prohibited responses

[`GHSA-ch52-4w7c-c8xp`](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
(CVE-2026-93748, upstream issue
[kornelski/http-cache-semantics#56](https://github.com/kornelski/http-cache-semantics/issues/56))
affects every published release (`<= 4.2.0`; 4.2.0 is the latest).
`maxAge()` returns 0 for responses that must not be reused (for example a
shared-cache response carrying `Set-Cookie` without `public`), but the stale
branch of `evaluateRequest()` only checked `must-revalidate` before honoring
the request's `max-stale`, so a client sending `Cache-Control: max-stale`
received another user's cached response and cookies.

The patch adds `_requiresRevalidation()`, which mirrors exactly the reuse
restrictions that zero `maxAge()` before any freshness is computed:

- the response is not storable (`!storable()`: `no-store` in the request or
  response, `private` or an `Authorization` request in a shared cache,
  uncacheable method or status);
- the response has `no-cache` (including `Pragma: no-cache` without
  `Cache-Control`);
- shared cache, `Set-Cookie`, and neither `public` nor `immutable`;
- `Vary: *`;
- shared cache and `proxy-revalidate`.

`evaluateRequest()` (and therefore `satisfiesWithoutRevalidation()`) now
returns a miss for such a response right after the existing `must-revalidate`
check. Ordinary expiry (`max-age`/`s-maxage` reached, `Expires` in the past,
heuristic freshness) is not a restriction, so `max-stale` and
`stale-while-revalidate` behave exactly as in 4.2.0 for those responses.
Because a restricted response always has `maxAge() === 0`, the only results
this changes are the hits 4.2.0 could return for it: through `max-stale`
(the advisory), through `stale-while-revalidate` in `evaluateRequest()`
(which `satisfiesWithoutRevalidation()` never counted as a hit), or through a
negative computed age (for example a negative `Age` header) that made it look
fresh.

## Patch 2: `Vary` wildcards and inherited field names

`GHSA-f27v-pv5m-c5g6` (CVE-2026-93750, upstream issue
[kornelski/http-cache-semantics#57](https://github.com/kornelski/http-cache-semantics/issues/57))
was published together with GHSA-ch52 against the same releases (through
4.2.0) and was still awaiting GitHub review, so not yet reported by
`npm audit`, when this package was built. Because this build's version sorts
above 4.2.0, it would hide that advisory once reviewed; shipping the fix
keeps the version honest. `_varyMatches()` takes the logic of upstream commit
[`9fb520be`](https://github.com/kornelski/http-cache-semantics/commit/9fb520be70eff3ff502fe965d9c3265ca2c64e26)
(merged on 2026-10-03, not yet released), re-indented to the file's style: a
`*` member anywhere in `Vary` (`" *"`, `"*,"`, `"accept, *"`) never matches,
and field names such as `constructor` never match through
`Object.prototype`.

## Not covered (unchanged from 4.2.0)

The `stale-if-error` fallback in `revalidatedPolicy()`, and
`useStaleWhileRevalidate()`/`timeToLive()` when called directly, still add
the response's own extension to the zeroed `maxAge()`. Those paths are opened
by the origin's response directives and by origin errors, not by the client
request the advisory describes, and closing them would also change
legitimate behavior (for example `no-cache, stale-if-error=N`, which asks a
cache to serve stale only while the origin is failing). Both Forge consumers
call `revalidatedPolicy()`, so that fallback stays exactly as in 4.2.0.

All other bytes are copies of the `http-cache-semantics@4.2.0` npm tarball
(integrity verified against the registry), whose `index.js` is identical to
upstream commit `f01112e9` on GitHub.

## Removal criteria

Remove this package, its `devDependencies`/`overrides` entries and its
provenance file as soon as upstream publishes a release that fixes
GHSA-ch52-4w7c-c8xp and GHSA-f27v-pv5m-c5g6 and the advisories list it as
patched. Note that `npm audit` compares prerelease versions too: if an
advisory range becomes `< 4.2.1`, this `4.2.1-nexus.1` build is reported as
vulnerable on purpose, forcing the switch to the official release.

Source hashes, npm integrity, commit pins and the patch summary are recorded
in `third_party/provenance/http-cache-semantics-4.2.0-compat.json`.
