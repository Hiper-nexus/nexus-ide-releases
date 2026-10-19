import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('protected Windows release worker', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/windows-release.yml', import.meta.url), 'utf8');
  const collector = fs.readFileSync(new URL('./collect-windows-release.ps1', import.meta.url), 'utf8');
  it('runs only from protected main on a fresh GitHub-hosted Windows machine and never publishes', () => {
    expect(workflow).toContain("github.ref == 'refs/heads/main' && github.ref_protected");
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).not.toContain('self-hosted');
    expect(workflow).toContain('environment: windows-release-signing');
    expect(workflow).not.toMatch(/pull_request:|contents: write|gh release|release:publish/);
  });
  it('validates exact commit and stable version', () => {
    expect(workflow).toContain('$branch.commit.sha -ne $env:GITHUB_SHA');
    expect(workflow).toContain('existing tag points at another commit');
  });
  it('never signs through the paid eSigner service, and refuses if signing is switched back on', () => {
    expect(workflow).not.toContain('WINDOWS_CERTIFICATE_SHA1');
    expect(workflow).not.toMatch(/^\s*NEXUS_WINDOWS_RELEASE_SIGNING\s*:/mu);
    expect(workflow).toContain('$env:NEXUS_WINDOWS_RELEASE_SIGNING -or $env:WINDOWS_CERTIFICATE_FILE');
    expect(workflow).not.toMatch(/-password=|-totp_secret=|-otp=/i);
  });
  it('hashes inner executable, Update.exe and Setup and smoke-tests before receipt upload', () => {
    expect(collector).toContain("$signing = 'none'");
    expect(collector).toContain('build/windows-signing-identity.json');
    expect(collector).toContain('sign all of them with the YubiKey or none');
    expect(collector).toContain('Update.exe');
    expect(collector).toContain('smoke-packaged-app.mjs');
    expect(collector).toContain('Get-FileHash');
  });

  const pwsh = process.platform === 'win32'
    ? spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
    : undefined;
  it.runIf(pwsh?.status === 0)('accepts only the pinned YubiKey signer, by thumbprint and public key', () => {
    // Runs the collector's real Get-ExecutableRecord. node.exe carries an
    // embedded, timestamped Authenticode signature from another publisher.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-collector-'));
    try {
      const unsigned = path.join(directory, 'unsigned.ps1');
      fs.writeFileSync(unsigned, "'unsigned'\n");
      const probe = path.join(directory, 'probe.ps1');
      fs.writeFileSync(probe, `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location $args[0]
$source = Get-Content -Raw scripts/collect-windows-release.ps1
Invoke-Expression $source.Substring(0, $source.IndexOf("if (\`$env:OS -ne 'Windows_NT'"))
function Try-Record([string]$file) { try { (Get-ExecutableRecord $file) | ConvertTo-Json -Compress -Depth 4 } catch { 'refused' } }
$node = $args[1]
$signer = (Get-AuthenticodeSignature -LiteralPath $node).SignerCertificate
$results = [ordered]@{ unsigned = Try-Record $args[2]; foreign = Try-Record $node }
$identity.certificateSha1 = $signer.Thumbprint
$identity.publisherCommonName = $signer.GetNameInfo('SimpleName', $false)
$results.otherKey = Try-Record $node
$identity.spkiSha256 = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($signer.PublicKey.ExportSubjectPublicKeyInfo())).ToLowerInvariant()
$results.pinned = Try-Record $node
$results | ConvertTo-Json -Compress
`);
      const result = spawnSync('pwsh', ['-NoProfile', '-File', probe, fileURLToPath(new URL('..', import.meta.url)), process.execPath, unsigned], { encoding: 'utf8', timeout: 60_000 });
      expect(result.status, result.stderr).toBe(0);
      const records = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
      expect(Object.keys(JSON.parse(records.unsigned))).toEqual(['sha256']);
      expect(records.foreign).toBe('refused');
      expect(records.otherKey).toBe('refused');
      expect(JSON.parse(records.pinned).signature).toMatchObject({ thumbprint: expect.stringMatching(/^[A-F0-9]{40}$/u), spkiSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
