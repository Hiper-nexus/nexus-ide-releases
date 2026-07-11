# Spike: Windows process sandbox (fail-closed)

**Date:** 2026-07-11  
**Status:** design spike (not production)  
**Goal:** Remove `production_eligibility=blocked-windows-sandbox` so Setup/NUPKG can ship in GitHub Releases for clients.

## Problem

`buildScopedExecPlan` on `win32` currently throws:

```text
secure process sandbox provider is unavailable on win32
```

Until a fail-closed provider exists, Nexus policy keeps Windows as **CI preview only** (signed artifacts may upload as `preview-assets-win32-x64`, never production release assets).

## Non-goals

- Full AppContainer packaging of the Electron UI itself  
- Matching every Seatbelt/bwrap feature on day one  
- Electron-builder migration  

## Options (evaluate in spike)

| Option | Isolation | Complexity | Notes |
|--------|-----------|------------|-------|
| **A. Job Object + restricted token** | Medium | Medium | Kill-on-close, CPU/memory, strip privileges; no FS jail by itself |
| **B. AppContainer (Appx-style SIDs)** | High FS/network | High | Best isolation; packaging/identity heavy for Forge |
| **C. ConPTY + ACL sandbox dir only** | Low–med | Low | Matches “home/tmp under sandboxDir” pattern; weaker than bwrap |
| **D. External helper (WSL2 / Windows Sandbox)** | High | Ops | Not suitable for default agent tool path |

**Recommended path for MVP:** **A + C** — Job Object for lifetime/resource + ACL-locked sandbox home (like Linux `HOME`/`TMPDIR` under `createScopedSandboxHome`), deny write outside `rootRealPath` + sandbox via explicit path checks already in tools, then harden.

Orca public tree does **not** expose a ready-made win32 sandbox to copy; harvest is **release matrix + signing rehearsal**, not sandbox code.

## Success criteria (exit spike)

1. `buildScopedExecPlan({ platform: 'win32', … })` returns a plan that runs `node -e "console.log(1)"` under confinement.  
2. Write outside `rootRealPath` fails (access denied or tool-level reject).  
3. Killing the Job Object kills the process tree (timeout parity with macOS test).  
4. Unit tests on `windows-latest` CI without admin elevation.  
5. Doctor reports sandbox available on Windows when probe passes.  
6. Release workflow: Windows assets allowed when probe + Authenticode green.

## Work breakdown (~2–3 days design+spike code)

1. **Day 1:** Spike harness (native addon or `child_process` + documented Win32 APIs via `koffi`/`ffi-napi` or small Rust/N-API helper). Prove Job Object create/assign/kill.  
2. **Day 2:** Integrate `createScopedSandboxHome` + env PATH allowlist parity with Linux/mac. Path traversal tests.  
3. **Day 3:** Wire `buildScopedExecPlan`, Doctor, release `production_eligibility`, document residual risks.

## Residual risks

- Without AppContainer, a compromised agent may still read many user files if PATH tools allow; mitigate with tool allowlists (already partial) and project-scoped cwd.  
- Antivirus may flag Job Object helpers; prefer well-known patterns.  
- Code-signing of any native helper mandatory for client trust.

## Decision gate

Go/No-Go for shipping Windows Setup in production release after criteria 1–4 pass on CI `windows-latest`.
