# Task 1 report: Windows x64 preview and certificate-store signing

## Status

Implemented and committed without push or merge.

- Added a private, unsigned Windows x64 preview workflow for
  `codex/windows-test-*` pushes and manual dispatch.
- Added certificate-store signing through a validated SHA-1 thumbprint while
  preserving the existing PFX mode and rejecting mixed or incomplete modes.
- Applied signing options to Electron Packager and MakerSquirrel with SHA-256,
  RFC 3161 timestamping, and fail-on-signing-error behavior.
- Added the Windows installer icon and made macOS-only `appdmg` optional so a
  clean Windows `npm ci` can omit it.
- Added `.dll` to ASAR native-library unpacking after confirming
  `onnxruntime-node` ships adjacent Windows DLLs required by its `.node` binding.
- Added the Windows build, CKA signing, signature verification, and release-gate
  runbook.

## Commits

- `d3e2b4a9` — `feat: support secure Windows release signing`
- `154d1028` — `ci: add private Windows preview build`

## Verification evidence

- TDD red: certificate-store and mixed-mode tests initially failed against the
  file-only implementation; the Windows DLL unpack test initially failed because
  the ASAR glob omitted `*.dll`.
- `npx vitest run forge.config.test.ts scripts/build-windows-icon.test.mjs build/prune-native-payload.test.ts`
  — 3 files, 38 tests passed.
- `npm run typecheck` — exit 0.
- `npm run security:renderer-sinks` — 0 executable DOM sinks.
- Ruby YAML parser loaded `.github/workflows/windows-preview.yml` successfully.
- `git diff --check` — clean before commits.

## Remaining concerns

- No Windows build was claimed from macOS. The pushed branch must complete the
  hosted Windows workflow before the unsigned preview is considered runnable.
- A real signed build still requires Windows, installed eSigner CKA, interactive
  authenticator approval, and certificate availability in the current user's
  Windows Certificate Store.
- The configured Squirrel `iconUrl` points to the intended public release-repo
  location, but `icon.ico` has not been published there. This does not block the
  private test artifact; it must be resolved before public release.
- Setup installation, installed-app signature/timestamp, clean-machine runtime,
  and uninstall remain mandatory Windows-side checks. The hosted preview is
  explicitly unsigned and not public-release eligible.
