---
name: stack-advisor
description: "Choose the project stack by policy, not habit: target OS, performance, one-click install, maintainer, ecosystem, security. Always query the registry at decision time, fail-closed on deprecated packages, pin versions. Use for new projects or tools when the stack is undecided."
---

# stack-advisor — decide the stack by policy, never by habit

You choose the language, framework and libraries for a NEW project or tool.
For an existing project, the project's own stack wins — do not re-decide it.

## 1. Mandatory inputs (all six, before answering)

1. **Target OS / distribution** — Windows/macOS/Linux/web/mobile/store (cuts half the options).
2. **Performance** — hot path? p99 latency? memory budget? (yes → Rust/Go; no → productivity first).
3. **Distribution / install** — single binary with no runtime (Go/Rust/.NET), web store (Tauri/Electron), app store (Expo/Flutter/Swift), `curl | sh` (Rust/Go). The operator is not a developer: one-click install wins ties.
4. **Maintainer** — what does the team already know? Respecting the existing stack is rule #1.
5. **Ecosystem / maturity** — maintainers, releases in the last 12 months, tests, docs, governance (foundation vs single person).
6. **Security** — attack surface, CVE history, sandbox, memory safety.

## 2. Target → choice → why (starting point, not verdict)

| Target | Recommended choice | Why |
|---|---|---|
| Native **Windows** tool | **Rust + windows-rs** (default); C++/WinUI 3 or .NET only if the maintainer is already from that house | single binary, memory safety, official WinAPI bindings, distribution = one `.exe` |
| **macOS** native | **Swift + SwiftUI** | only frictionless path to App Store/notarization/OS integrations |
| **Multiplatform desktop** | **Tauri 2** for new projects; **Electron** when the app already is Electron or needs full Node/PTY | Tauri: ~10× smaller binary, OS webview, Rust backend; Electron: maturity, sandbox, real Node |
| **CLIs** | **Go** by default; **Rust** when latency/memory safety is a requirement | Go: static binary, trivial cross-compile, full stdlib; Rust: no GC, fearless concurrency |
| **Backend services** | **Go** (network/infra), **Rust** (hot path), **Node LTS** when the team is JS/full-stack, **Elixir** for distributed real-time | choose by constraint, not fashion |
| **Web apps** | **Next.js** (SSR/RSC/edge), **React Router** (leaner full-stack), **SvelteKit** (less boilerplate), **Rails** (CRUD/back-office) | by rendering requirement and deploy ecosystem |
| **Data / ML** | **Python + uv** (+ ruff/ty) | uv replaces pip/poetry/pyenv with a single lockfile, 10–100× faster |
| **Mobile** | **Expo/React Native** if the team is JS; **Flutter** for fast multiplatform UI; **Swift/Kotlin** when the requirement is device APIs | one codebase × two stores; native only when the device demands it |
| **Automation scripts** | **Bash + jq** (one-liners), **Python + uv script** (logic with deps), **tsx/TypeScript** inside a JS repo | zero setup cost beats power |
| Ruby / PHP (legacy web or CMS) | only if the project already lives there — conventionality wins | never pick these for a new project out of nostalgia |

Versions below are DATED EXAMPLES (03/10/2026) — re-query the registry now,
never trust them: Rust 1.99.0, Go 1.27.1, Node 24 LTS (v24.21.0), Tauri 2.12.1,
Electron 44.5.1, Next 16.3.8, React Router 8.4.0, SvelteKit 3.0.0, Rails 8.1.4,
React 19.3.0, Vite 8.3.2, TypeScript 7.0.2, uv 0.12.22, Swift 6.4, .NET 10 LTS,
Elixir 1.20.4, windows-rs 0.62.2, Expo SDK 57 / RN 0.87, Flutter 3.47.0,
Ruby 4.0.7, Laravel 13.34.0, Bun 1.4.2.

## 3. "Library always current" rule (run AT decision time, never from memory)

Query the registry for every library you propose:

- npm → `npm view <pkg> version` (or `https://registry.npmjs.org/-/package/<pkg>/dist-tags`)
- Rust → `https://crates.io/api/v1/crates/<name>`
- Go → `pkg.go.dev`
- Ruby → the rubygems API (`https://rubygems.org/api/v1/gems/<name>.json`)
- Python → `https://pypi.org/pypi/<pkg>/json`

Refuse FAIL-CLOSED — list the evidence and propose an alternative, never
proceed silently — when a package is `deprecated` in the registry, has no
release in more than 18 months, has no license, is single-maintainer with no
release since 2024 and no justification, has near-zero downloads, or only
exists to prop up an abandoned package.

Pin the version exactly in the manifest/lockfile (`package.json` without
`^`/`~` on critical libs, `package-lock.json`, `Cargo.lock`, `go.sum`,
`uv.lock`) — follow the project's own version-pinning style.

## 4. Fixed output format

`{linguagem, framework, libs[{nome, versão}], justificativa ≤ 3 frases, fontes}` —
one `fontes` registry URL per library, plus the versions you actually queried.

## 5. Preserve the project decision

Propose `.context/docs/stack-decision.md` with `nexus_context_draft_propose`:
use `targetPath`, the complete decision as `content`, and real `sources` that
the context tools can verify. Include the six constraints, chosen versions,
registry URLs, rejected alternatives and verification commands. Never invent
source hashes. The existing independent review/apply flow must accept the draft
before it becomes project authority; never write `.context` directly.

If your role cannot call the proposal tool, include the complete draft and its
sources in your handoff to the Maestro. A short summary is not the record.
