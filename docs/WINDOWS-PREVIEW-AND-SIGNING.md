# Windows x64 preview and signing

Para continuar esta tarefa em outra máquina, comece pelo
[roteiro Windows com certificado público](windows-signing/CONTINUAR-NO-WINDOWS.md).

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

The Windows CI smoke installs the repository-pinned `@openai/codex@0.145.0`
under the runner's temporary directory and exposes only its native
`codex.exe` directory on `PATH`. It proves that executable through node-pty
before packaging. The functional mission-preparation probe requires a real
executable CLI, but does not log in or use provider tokens. Codex is not bundled
into NexusIDE.

Windows CLI spawning requires a native executable. Compatibility with npm
`.cmd` and extensionless Unix shims is tracked separately and is not implied by
this preview prerequisite.

## Build with the SSL.com eSigner certificate store

A full signed build must run on Windows with eSigner CKA installed and the
operator authenticated through the configured authenticator. CKA exposes the
non-exportable private key through the Windows Certificate Store. Do not pass
an eSigner password, PIN, or OTP in process arguments.

1. Open eSigner CKA and complete its interactive sign-in and authenticator flow.
2. Find the single intended code-signing certificate in the Local Machine
   certificate store and copy its 40-character SHA-1 thumbprint:

   ```powershell
   Get-ChildItem Cert:\LocalMachine\My -CodeSigningCert |
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

## Worker contínuo e publicação com Mac

O workflow `windows-release.yml` está preparado para um runner Windows x64
protegido com o label `nexus-release-signing` e CKA já configurado em modo
automático sob a conta real do serviço. Ele não foi executado nem registra um
runner automaticamente. O ambiente GitHub `windows-release-signing` deve restringir
branches a main e fornecer apenas o thumbprint público `WINDOWS_CERTIFICATE_SHA1`;
a autenticação CKA deve ser provisionada pelo titular no host.

O publicador comum agora exige `NEXUS_WINDOWS_RELEASE_RUN_ID` e valida a origem
autenticada, commit e digest do artifact do workflow, em vez de confiar em recibo
local. Veja [RELEASE.md](RELEASE.md). Todos os futuros releases por esse comando
exigem Windows junto com Mac. O workflow ainda não comprova instalação ou upgrade
assinado N→N+1; essa validação continua necessária antes da primeira publicação.

O Setup e o executável observados no preview ultrapassam o limite de 200 MB do
eSigner Express web. Use a integração CKA nativa para o processo completo.
O pacote observado tem 21 arquivos PE, além de possíveis etapas de assinatura
do instalador: saldo de 40 assinaturas não equivale a 40 versões.

Estado externo verificado nesta tarefa: `main` ainda estava com `protected=false`.
Por isso o novo worker permanece desabilitado até configurar proteção de main,
além de registrar o runner e provisionar o CKA. Nenhuma dessas configurações foi
alterada. Os testes de publicação com fixtures Mac ficam no Mac; o worker roda
os testes de empacotamento/updater usados pelo preview Windows. O PowerShell do
novo coletor ainda não foi executado em host de assinatura.

A publicação agora bloqueia também um candidato assinado com smoke verde se
ainda faltar a prova autenticada de upgrade instalado N→N+1. O coletor atual
continua emitindo installedUpgradeVerified=false; ele gera candidato privado,
mas **não autoriza publicação pública**. O harness real ainda precisa ser
implementado/executado no worker e vincular a prova ao mesmo commit, versão,
run e hashes. Nenhuma flag foi promovida artificialmente a true.
