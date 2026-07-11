# FASE 1 — P1 complete (Gaps A/B/C) status

**Date:** 2026-07-11  
**Tip base:** `26d0253`  
**Pin ORCA:** `143c36e566483006fe54fa2716b019ec00599752`

| Gap | Status | Evidence |
| --- | --- | --- |
| **A** Managed hooks Claude+Codex | **GO** | `register-default-installers` + FS installers + loopback HTTP → `PaneSessionState`; registry non-empty; §12.4 `authorizesEvidence: false` |
| **B** child-process-gone + GPU marker | **GO** | `handleChildProcessGone` in bridge; `app.on('child-process-gone')` in main; `gpu-fallback-marker` applied pre-whenReady; `crash-report-pending` local only |
| **C** token resolver + get PR/MR | **GO** | `forge-token-resolver` injectable; GH/GL `getReviewForBranch` mock HTTP; writes still authz+audit |

**Gates:** verify-agent-runtime-wiring PASS; verify-orca-provenance PASS; typecheck PASS; npm test 2× PASS (3088).
