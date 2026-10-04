# Private packaged runtime acceptance

This PLANTask5 harness and its source fixtures do not certify the final signed
app, OS microphone grant, actual CLI runtime, or the pixels of a capture.

Run from the actual clean annotated release-tag checkout after generating
the signed ZIP/DMG and schemaVersion2 candidate-build.json. The existing
packaged-soak binding verifies Git HEAD/tag, source SHA, version, lock/build
authority, full ZIP/bundle bytes, Developer ID signature and fuses before
and after the run. No source argument alone is accepted as provenance.

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH python3 \
  .superpowers/sdd/PLAN/with-validation-lock.py \
  /opt/homebrew/opt/node@22/bin/node scripts/smoke-packaged-runtime-gates.mjs \
  --verify-runtime-gates \
  --app /absolute/path/to/NexusIDE.app \
  --zip /absolute/path/to/the-receipt-candidate.zip \
  --build-receipt /absolute/release-root/release-artifacts/candidate-build.json \
  --source-sha ACTUAL_FULL_RELEASE_TAG_SHA \
  --expected-version 0.76.192 \
  --evidence-dir /absolute/new/runtime-evidence
```

The launcher creates its own private HOME/userData/tmp and Git workspace,
starts one bounded loopback inference fixture and launches the packaged app
twice sequentially in that profile. Both launches require initial and final
functional probes and natural quit with physical PTY/tree proof. Main nonce
and Main/renderer PIDs must be fresh, while CLI bytes/version and persisted
native conversation/memory state remain exact. Inspector/CDP stay disabled.
Unknown process proof retains the private profile and never earns PASS
through external reap. Each launch has a finite 600-second outer ceiling.

The first launch uses canonical mission prepare/start/command and existing
renderer actions. The actual installed Claude CLI performs an ops terminal
command without workers, opens at most two standard workers, submits actual
handoffs and ACKs the exact consumed row. Main checks linked physical ACK
receipt/delivery IDs and the matching audit invocation/live Maestro session.
A worker is physically terminated and recovered through normal exact resume.
The passive Main observer records the canonical retry refusal and answer
result for the exact visible question without changing command outcomes.
Workspace memory is attested/recalled through existing APIs and checked in
the actual Main store. Two private loose shells are reordered in the real
grid; connected visible xterm must move and show independently observed PTY
echo while session/PID remain unchanged. No new tab/worktree authority is
created by that presentation operation.

The writer's Main-classified visual assignment requires an actual Nexus
browser open/screenshot of a tiny static page on the same gateway. Existing
visual-handoff and BrowserArtifactStore checks re-prove assignment/session/
mission/execution provenance and PNG hash. The launcher preserves PNG bytes
outside the disposable session. The receipt explicitly records
`visualInspection: pending-human-image-inspection`: the release reviewer
must inspect the preserved image before closing N7.

Voice is mandatory. Main reads the existing OS grant; anything other than
`granted` is an observed external blocker and fails without asking for a
permission. A Main-only nonce/frame/scope lease permits audio solely from
the exact private main-frame entry URL in both Electron permission paths.
Camera, mixed/unknown media, subframes and stale/released leases are denied.
Existing PTT/Jarvis starts capture. The observer records actual track IDs,
AudioContext object identities/states and worklet frame count; normal
power-off/hard teardown must end those same tracks and close that graph.
No PCM is saved by the verifier, replacement capture controller or TCC/global
policy change is introduced. The receipt requires real Electron 43.7.4.

The second launch recalls the actual persisted workspace memory and resumes
the same provider conversation through canonical mission resume. A real CLI
reply must demonstrate earlier conversation survived; cached metadata alone
cannot pass. It stops the resumed mission before repeated functionality and
natural physical exit.

Ordinary launches are dormant. Explicit packaged smoke, harness-owned private
profile, loopback parent-owner handshake, initial private renderer marker and
Main nonce/frame/scope are required. There is no new public window.nexus API,
bypass flag, mission row/status mutation, manufactured ACK, operator login/
configuration or external inference endpoint. Existing smoke-only F250
license behavior is preserved; this does not test commercial login/licensing.
Only inference is simulated. The gateway chooses actual advertised closed
ToolDefs and bounds sockets, bytes before JSON parse, requests, read/idle
deadlines, lifetime and physical server close.

Source checks at delivery: focused union 272 PASS/15 suites, voice/frame/window
follow-up 73 PASS/8 suites, final core follow-up 26 PASS/8 suites; app typecheck
exit0 before the small final receipt/loader/message-ID changes. Disk exhaustion
then prevented further heavy checks; those last edits require the Root's
private focused/full type/test gate. The real Node22 CLI now reaches argument
validation and refuses incomplete invocation with exit1. No signed field
execution is claimed. Sinks/Sync results are recorded in the delivery report.

Still required: independent source review; final private tests/types; execute
this exact verifier on the signed candidate, retain receipts and inspect PNG;
close the independent keychain/endpoint/updater oracles elsewhere in Task5.
Fixtures, disabled microphone or successful prepare/list cannot replace field
results.
