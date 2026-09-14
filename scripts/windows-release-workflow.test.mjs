import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('protected signed Windows worker', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/windows-release.yml', import.meta.url), 'utf8');
  it('runs only from protected main on the dedicated signing host and never publishes', () => {
    expect(workflow).toContain("github.ref == 'refs/heads/main' && github.ref_protected");
    expect(workflow).toContain('runs-on: [self-hosted, Windows, X64, nexus-release-signing]');
    expect(workflow).toContain('environment: windows-release-signing');
    expect(workflow).not.toMatch(/pull_request:|contents: write|gh release|release:publish/);
  });
  it('uses only certificate-store signing, validates exact commit and stable version', () => {
    expect(workflow).toContain('WINDOWS_CERTIFICATE_SHA1');
    expect(workflow).toContain('$branch.commit.sha -ne $env:GITHUB_SHA');
    expect(workflow).toContain('existing tag points at another commit');
    expect(workflow).not.toMatch(/-password=|-totp_secret=|-otp=/i);
  });
  it('verifies inner executable, Update.exe and Setup plus timestamps before receipt upload', () => {
    const collector = fs.readFileSync(new URL('./collect-windows-release.ps1', import.meta.url), 'utf8');
    expect(collector).toContain('Get-AuthenticodeSignature');
    expect(collector).toContain('TimeStamperCertificate');
    expect(collector).toContain('Update.exe');
    expect(collector).toContain('smoke-packaged-app.mjs');
    expect(collector).toContain('Get-FileHash');
  });
});
