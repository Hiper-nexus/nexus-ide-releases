# Mobile companion v1 plan (Gap E)

**Date:** 2026-07-11  
**Stack decision (locked):** **Thin client / PWA** over existing `remote-bridge` WebSocket JSON-RPC + binary terminal stream.  
**Not chosen:** React Native monorepo / ORCA `mobile/` import.

## Preconditions (FASE 2)

| Gate | Status |
| --- | --- |
| D0–D5 mock e2e stream+SSH+FS+Git | **GO** |
| Pairing + revoke on desktop bridge | **GO** (`revokeRemoteTokens` closes clients) |
| D6 resume helpers | **GO** lean |
| D9 E2EE key agreement | **PENDING** — transport confidentiality is TLS; pairing is identity proof only |

## v1 surface (thin client)

| Feature | Transport | Notes |
| --- | --- | --- |
| Pairing → token | existing bridge auth | device challenge/response |
| List panes | JSON-RPC | read |
| Read output / stream subscribe | binary stream | seq resume D6 |
| Send input | stream Input opcode | |
| Mission list | JSON-RPC read | no mission complete from mobile |
| Destructive writes | require `confirmDestructive` on device | policy module |
| Revocation | desktop revoke → socket close | already in bridge |

## Explicit non-goals v1
- Import ORCA mobile renderer
- Agent force / mission done from device
- Offline-first local DB
- App Store RN packaging

## Implementation status this goal
- Plan + stack decision: **this file**
- Companion **policy** (destructive confirm, revoke semantics): `src/main/remote/mobile-companion-policy.ts`
- Full PWA shell packaging / offline SW: **PENDING** follow-up (not blocking FASE 2)

## Security
- Scope authority remains local `ProjectExecutionScope`
- Hooks still never authorize evidence
- No secrets in project `.nexus`
