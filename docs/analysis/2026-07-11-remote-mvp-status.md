# FASE 2 — Remote production MVP status

**Date:** 2026-07-11  
**Pin:** `143c36e566483006fe54fa2716b019ec00599752`

| Sprint | Item | Status |
| --- | --- | --- |
| D0 | Protocol map JSON-RPC × stream × SSH | **GO** — `docs/analysis/2026-07-11-remote-bridge-protocol-map.md` |
| D1 | ssh config/path/identity pure | **GO** — unit tests |
| D2 | SSH session manager + mock transport | **GO** — mock ssh2 |
| D3 | Remote FS + containment | **GO** |
| D4 | Remote Git read-mostly + policy | **GO** |
| D5 | Remote PTY + terminal-stream | **GO** — mock e2e |
| D6 | reconnect/resume seq | **GO** lean helpers |
| D7 | WSL beyond detect | **PENDING** |
| D8 | security negatives | **GO** |
| D9 | E2EE/pairing crypto path | **PENDING** (pairing proof exists; no E2EE) |

**MVP GO criterion:** mock e2e stream+SSH+FS+Git in main-process unit suite — **YES**.  
**Host real Win/Linux:** **PENDING** (no real ssh2 dep; no live host in this goal).

**Not done (honest):** replace remote-bridge with SSH mux; WSL hooks; production E2EE.
