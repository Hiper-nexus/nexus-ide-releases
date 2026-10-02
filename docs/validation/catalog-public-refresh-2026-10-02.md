# Public model-catalog refresh — 2026-10-02

The default catalog URL pointed to a private source repository and returned HTTP 404 anonymously. The refresh copy now lives at `https://raw.githubusercontent.com/Hiper-nexus/nexus-ide-releases/catalog/resources/model-catalog.json`.

The published file is byte-identical to `resources/model-catalog.json` from private source commit `e860b15faea4a5856475dd703fc30fd9f642254d`: Git blob `47a93098b2ab27904795a239e92987927bed1ed8`, SHA256 `814c237d0dda678b90caf603e24d82f71dec6a768c0973f00a1c834863956f1c`, 12,569 bytes, 15 adapters and 69 models. Public catalog commit `40c8408c08cc4f5cc12d47126554df6df34042dc` has tree `259d78063bb68227c413533cc56da62b96edb801` and only public parent `44ed5efa759fec4daef9e3bc7249d62f611fa54c`. It adds only this JSON to the public README/icon history; private code and private Git ancestry were not published.

Anonymous HTTPS GET returned 200 and the expected hash in Node 22.23.2 and in the actual Electron 43.7.4 Main process (Node 24.21.0). A subsequent warm loader request succeeded, but that did not establish cold-start behavior: the GET preflight took more than five seconds.

Fresh processes then invoked the real loader as their first network request, with no preflight, no URL override and no retry. Each process had an isolated in-process home and an existing empty overlay, which prevents the bundled fallback from counting as a remote success. `NODE_USE_ENV_PROXY=1` and `NODE_USE_SYSTEM_CA=1` were set; the inherited extra CA remained in place. TLS verification stayed enabled and no authenticated request headers or provider inference were used.

| Runtime | Five-second timeout, two fresh processes | Ten-second timeout, fresh process |
| --- | --- | --- |
| Node 22.23.2 | Both aborted at about 5.0 s; refresh false | HTTP 200; refresh true in 5.641 s |
| Electron 43.7.4 Main / Node 24.21.0 | Both aborted at about 5.0 s; refresh false | HTTP 200; refresh true in 5.312 s |

The isolated code candidate changes the default endpoint and increases the bounded timeout from five to ten seconds. This allows the measured cold proxy/TLS connection time while retaining cancellation, normalization, model IDs, version/date precedence, cache behavior and fallback rules. The timeout test failed against five seconds and passed against ten; the full model-catalog file passed 25 tests. It verifies no abort before 9.999 s, abort at 10 s, a false refresh result and exact preservation of an existing overlay. The existing missing-overlay bundled fallback remains covered.

With the requested system-CA flag, the effective default CA count increased from 146 to 522 in Node and from 122 to 498 in Electron Main. Each reported 376 system CAs and one extra CA. Cold loader results contained all four requested IDs unchanged: `claude-sonnet-5-5`, `claude-opus-5-5`, `gpt-6.1-sol` and `gpt-6-astra`.

This evidence covers `globalThis.fetch` and the real catalog loader in Main. The Electron probe used a temporary profile and root-only `--no-sandbox`, `--ozone-platform=headless` and `--disable-gpu` harness switches; none is a production launcher change. Catalog presence does not establish account entitlement or successful model inference. The measured cold requests are a small sample, and a ten-second timeout can still fall back on a slower or unavailable network.
