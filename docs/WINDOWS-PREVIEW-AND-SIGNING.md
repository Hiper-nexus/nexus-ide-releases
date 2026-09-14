# Windows x64 preview and signing

The hosted `Windows x64 unsigned preview` workflow builds only private test
artifacts. Its Setup.exe and NUPKG are unsigned, have not been validated through
the installer, and are not eligible for a public release. A push to a
`codex/windows-test-*` branch or a manual dispatch starts the workflow.

## Build an unsigned preview

Use Windows x64 with Node 22.23.2, Python, and the Visual Studio C++ build tools:

```powershell
npm ci
npm run typecheck
npm run security:renderer-sinks
npx vitest run forge.config.test.ts scripts/build-windows-icon.test.mjs build/prune-native-payload.test.ts
npm run make -- --platform win32 --arch x64
```

Run `scripts/smoke-packaged-app.mjs --app <path-to-nexus-ide.exe>` against the
executable extracted from the full NUPKG. This proves the packaged runtime; it
does not prove installation through Setup.exe.

## Build with the SSL.com eSigner certificate store

A full signed build must run on Windows with eSigner CKA installed and the
operator authenticated through the configured authenticator. CKA exposes the
non-exportable private key through the Windows Certificate Store. Do not pass
an eSigner password, PIN, or OTP in process arguments.

1. Open eSigner CKA and complete its interactive sign-in and authenticator flow.
2. Find the single intended code-signing certificate in the current user's
   certificate store and copy its 40-character SHA-1 thumbprint:

   ```powershell
   Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
     Format-List Subject, Thumbprint, NotAfter
   ```

3. Confirm the subject and expiry, then build with certificate-store signing:

   ```powershell
   $env:NEXUS_WINDOWS_RELEASE_SIGNING = '1'
   $env:WINDOWS_CERTIFICATE_SHA1 = '<40-character-thumbprint>'
   npm ci
   npm run make -- --platform win32 --arch x64
   ```

The build fails closed when the thumbprint is invalid, when certificate-store
and PFX settings are mixed, or when SignTool reports an error. The packager and
Squirrel installer use SHA-256 with an RFC 3161 timestamp from DigiCert.

The existing PFX mode remains available by setting
`WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD` instead of the
thumbprint. A downloaded `.cer` or `.pem` contains no private key and cannot
replace either a PFX with its password or the authenticated CKA store.

## Verify the signed result

Verify both the installed application executable and Setup.exe. Checking only
the outer installer does not prove that the app inside the NUPKG was signed.

```powershell
signtool verify /pa /all /v '<path-to-Setup.exe>'
signtool verify /pa /all /v '<installed-path-to-nexus-ide.exe>'
Get-AuthenticodeSignature '<path-to-Setup.exe>' | Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
Get-AuthenticodeSignature '<installed-path-to-nexus-ide.exe>' | Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

Both files must report a valid signature from the expected publisher and a
timestamp certificate. Install on a clean Windows machine and exercise launch,
workspace opening, PowerShell terminal creation, persistence, provider login,
a simple mission, process shutdown, and uninstall before considering a Windows
release candidate. The private preview workflow alone never satisfies this
release gate.

## Continuous updates

An installed Windows x64 build uses the official Electron update service feed
for `Hiper-nexus/nexus-ide-releases`. Portable packages and installations
without the adjacent Squirrel `Update.exe` do not update. The first automatic
check waits at least ten seconds after a `--squirrel-firstrun` launch so the
installer can release its file lock.

Every stable public Windows release must contain signed assets from the same
authorized version and commit:

- one Setup `.exe` whose filename contains `-win32-x64-`;
- exactly one full NUPKG, preserving the MakerSquirrel filename;
- the matching unchanged single-entry `RELEASES` file.

Do not publish the private workflow's unsigned preview files. The inner
installed application and Setup must both have valid publisher signatures and
timestamps before those assets are attached to the public stable release. A
real installed N to N+1 update remains required before claiming continuous
Windows update delivery.
