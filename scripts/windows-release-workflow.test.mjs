import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('protected Windows release worker', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/windows-release.yml', import.meta.url), 'utf8');
  it('runs only from protected main on the dedicated Windows host and never publishes', () => {
    expect(workflow).toContain("github.ref == 'refs/heads/main' && github.ref_protected");
    expect(workflow).toContain('runs-on: [self-hosted, Windows, X64, nexus-release-signing]');
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
    const collector = fs.readFileSync(new URL('./collect-windows-release.ps1', import.meta.url), 'utf8');
    expect(collector).not.toContain('Get-AuthenticodeSignature');
    expect(collector).toContain("signing = 'none'");
    expect(collector).toContain('Update.exe');
    expect(collector).toContain('smoke-packaged-app.mjs');
    expect(collector).toContain('Get-FileHash');
  });
});
