# Actual MiMo default Nexus control

After the operator explicitly authorized ordinary Nexus full-auto execution
and network freedom, the remaining controls use actual `buildControlArgs`
defaults in both baseline and scheduled phases. This is the existing product
policy, not a test allowlist or removal of an SDK guard. The earlier Qwen
ordinary-approval and restricted negatives remain separate historical proof.

MiMo Code 0.1.15 is a Node npm launcher followed by the native ARM64 runtime:
`@mimo-ai/mimocode-darwin-arm64/bin/mimo`, 100234850 bytes, SHA256
`00013ea578d01e069cacfa085ff79e5065a570e84d9c321e967707b5040d8eed`.
Wrapper SHA256 is `b8898bbb2717cb29a1c03137b6b6117ae3c03e2990322ad9ee1e92d195cc5869`.
Node22 drives the wrapper; the actual native ACP `agentInfo` identifies
OpenCode 0.1.15. Native launcher bytes, rather than Node presence, define this
transport. The fixture captures both wrapper and native hashes for future runs.

Private HOME/config/db/cwd uses the supported `MIMOCODE_HOME`,
`MIMOCODE_CONFIG_CONTENT` and selected Xiaomi model/provider options already
used by Nexus `cli-mcp-session-mimo`. Only the declared model gateway's local
synthetic API key is seeded; no operator auth/file is linked. The native
default shell is the inherited zsh. Default `buildControlArgs` declares
full-auto, and existing `mimoSkipPermissionsViaEnv` (F742) converts the
verified flag to its official environment surface. The fixture does not
send the CLI's bypass-warning prompt an invented answer; it invokes the same
Main conversion. Baseline and scheduled use the same resulting arguments
(`acp --cwd <owned-workspace>`) and environment mode.

Actual result: **1 PASS/1 suite**, with two nonselected CLI cases skipped,
under the Root mutex and Node22. Receipt:
`/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-mimo-control-rR2HP0/receipt.json`.
It captures actual HEAD5008b55f4 and exact in-flight fixture SHA256
`9545b25d2a0e99e461bf2b89630df8081f052b0aa882e1dff817417d1539fe31`, plus
resource/helper/Node/entry hashes; this is not a claim that the later fixture
edits were already committed in that HEAD.

| Phase | CLI/supervisor PID | Main requests | Physical close | Artifact SHA256 |
|---|---|---|---|---|
| baseline | 91241 | none | EOF, code0/no signal | `76065e2f5cd7fd81f456a269cdabfcc6ebcbbd6768f6ad5dead5ddc02090acea` |
| scheduled | 91337 | fresh darwin-job91416; nested borrow91482; one grant/release | EOF, code0/no signal | `47beb283a682824f4280e9879fc22823b404c2ed5509fc8dceea15b03df1eecf` |

Both real advertised `bash` tool executions produced the same finite
Make→Node result with stripped NODE_OPTIONS. The Main scheduler phase reuses
the frozen strong supervisor/owned A+B claims, whole-cohort watcher and
permit. The wrapper root is pinned by canonical NEXUS_HEAVY_AGENT_ENTRY.
Neither CLI close reported responsibility-unknown; stderr contains only
the private first-boot SQLite migration notice. No SDK guardian or physical
assertion was removed.

Network policy is explicit. MiMo ACP itself starts a private ephemeral
loopback server and connects to it. A fixture allowing only the model port
failed before tools (`Failed to start server on port0`, then local connection
error). The successful fixture retains ordinary local server/client access,
while preventing external traffic for the finite test. It does not claim
Nexus full-auto network denial. The second owned loopback probe is allowed
in both phases, as expected; no false denied-network label is recorded.
Writes to the second owned private location are also allowed by the normal
file policy. Earlier restricted-profile failures are qualification boundaries,
not scheduler bugs or healthy-default product failures.

Reproduce one CLI at a time:

```sh
NEXUS_TEST_NATIVE_NODE_CLI=mimo PATH=/opt/homebrew/opt/node@22/bin:$PATH \
  python3 /Users/cleofaspereirarocha/.nexus-worktrees/release-076191-final/.superpowers/sdd/PLAN/with-validation-lock.py \
  /opt/homebrew/opt/node@22/bin/node ./node_modules/vitest/vitest.mjs run \
  src/main/orch/native-heavy-node-clis.test.ts --maxWorkers=1
```

Final focused rerun after the native-hash addition also passed, receipt at
`/private/var/folders/sx/x73nxt3s0tnfhs1n_bl38bc40000gn/T/nexus-c6-mimo-control-XKWbKa/receipt.json`.
Its exact fixture SHA256 is
`78d5bfe385e133e2f60ea863bf468b5f069812fe6433afda2473c179ffdb8c8d`,
actual HEAD5008b55f4 and the native hash above. Baseline outer PID2508 had no
admission; scheduled outer2599 had fresh job2684 and borrow2734, one
grant/release. Both physical closes remained EOF/code0/no signal. Phase
hashes: baseline `bad1f14e1c288e63e7654fcaf16aa0a72c50a8d1b5c95572c67f4c72aa667fc1`;
scheduled `da26c6ae6a7fd6a2a2a45ccd393c8289d4056ad90b10ce02bddde8f9b18bd3c4`.
Final app typecheck passed; renderer sinks0 and Main Sync91 passed under the
same mutex. Source fixtures/docs do not
qualify the signed app. MiniMax's real guardian regression and Qwen's later
physical inventory UNKNOWN remain open with the Native resource owner.
