# Remote bridge protocol map (Gap D0)

**Date:** 2026-07-11  
**Pin ORCA:** `143c36e566483006fe54fa2716b019ec00599752`  
**Status:** living map — JSON-RPC bridge × binary stream × future SSH mux

## Layers (do not collapse)

| Layer | Transport | Authority | Status in Nexus |
| --- | --- | --- | --- |
| **A. Local remote-bridge** | WebSocket JSON-RPC (`remote-bridge.ts`) over TLS optional | `ProjectExecutionScope` local; pairing token | Production |
| **B. Terminal binary stream** | `terminal-stream-protocol` frames (opcode/streamId/seq) over WS or SSH channel | Same scope; stream subscribe gated | Wired in remote-bridge pane stream |
| **C. SSH host capability** | ssh2 (or mock) under `RemoteHostCapability` | Capability attached to scope; **never** agent-force | MVP mock session manager (D2+) |
| **D. Future SSH mux** | Multiplexed control + SFTP + PTY channels on one SSH | Same as C | **PENDING** — not replacing bridge in one shot |

## Strangler rule

- Keep `remote-bridge` as the companion entry.
- Add SSH as an **optional capability** (`kind: 'ssh'`) for host FS/PTY/Git.
- Binary stream is shared (layer B) whether source is local PTY or remote PTY.
- E2EE beyond TLS + pairing proof remains **D9 PENDING** (see `device-pairing.ts` scope note).

## Message families

### JSON-RPC (layer A)
- `pane.list` / `pane.read` / `pane.stream.*` / spawn / pairing
- Fail closed when scope missing or device revoked

### Binary stream (layer B)
- opcodes: Output, Input, Resize, Subscribe, Snapshot*, Error
- reconnect uses `seq` resume (D6)

### SSH session (layer C)
- connect / auth / keepalive
- FS: list/read/write with `ssh-path` containment
- Git: status/diff/fetch read-mostly; writes policy-gated
- PTY: bytes → layer B frames

## Security invariants
1. Host = capability; authority = local `ProjectExecutionScope`
2. No agent-accessible force
3. Path containment via `resolveSshPathInsideRoot`
4. Secrets never in project `.nexus/`
5. Rate/frame limits on stream frames (relay-framing)

## Honest PENDING
- Real ssh2 production dependency + host Win/Linux e2e
- Full SSH channel mux (ORCA-scale)
- WSL beyond detect (D7)
- E2EE key agreement (D9)
