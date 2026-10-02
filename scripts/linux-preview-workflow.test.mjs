import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
const workflow = fs.readFileSync(new URL('../.github/workflows/linux-preview.yml', import.meta.url), 'utf8');
describe('Linux preview workflow separation', () => {
  it('provisions the real pinned Linux Codex prerequisite before mission smoke', () => {
    const install = workflow.indexOf('node scripts/install-linux-smoke-codex.mjs');
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(workflow.indexOf('xvfb-run -a node scripts/smoke-packaged-app.mjs'));
    expect(workflow).toContain('name: linux-codex-smoke-prerequisite');
  });
  it('builds unprivileged PR and main push sources without release credentials or tags', () => {
    expect(workflow).toContain('name: Linux x64 preview');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('push:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toMatch(/pull_request_target|contents: write|secrets\.|GH_TOKEN|workflow_dispatch|gh release|release:publish|release:security|refs\/tags/);
  });
  it('verifies pinned toolchain and all three runtimes before writing preview-only artifacts', () => {
    expect(workflow).toContain('bootstrapPinnedNpm');
    expect(workflow).toContain('expectedIntegrity: authority.npmPackageIntegrity');
    expect(workflow).toContain('npm run make -- --platform linux --arch x64');
    expect(workflow).toContain('npm audit --audit-level=moderate');
    expect(workflow).toContain('node scripts/browser-functional-smoke.mjs --output-dir release-artifacts/browser-smoke');
    expect(workflow).toContain('name: linux-browser-smoke');
    expect(workflow).toContain('sudo apt-get install --no-install-recommends -y "$DEB"');
    expect(workflow).toContain('python3 scripts/extract-linux-zip.py');
    expect(workflow).toContain('scripts/smoke-packaged-app.mjs --app "$ZIP_BINARY"');
    expect(workflow.indexOf('--app "$ZIP_BINARY"')).toBeLessThan(workflow.indexOf('node scripts/collect-linux-preview.mjs'));
    expect(workflow).toContain('name: linux-x64-preview');
    expect(workflow).toContain('name: linux-x64-preview-receipt');
    expect(workflow).not.toMatch(/name: linux-x64-release\s|name: linux-x64-receipt\s/);
  });
});


describe('Debian installed package proof', () => {
  it('runs the additional OS smoke after package creation before collecting preview receipts', () => {
    expect(workflow).toContain('bash scripts/smoke-debian-package.sh 2>&1 | tee release-artifacts/debian-smoke/debian-12-install-smoke.log');
    expect(workflow.indexOf('npm run make -- --platform linux --arch x64')).toBeLessThan(workflow.indexOf('bash scripts/smoke-debian-package.sh'));
    expect(workflow.indexOf('bash scripts/smoke-debian-package.sh')).toBeLessThan(workflow.indexOf('node scripts/collect-linux-preview.mjs'));
    expect(workflow).toContain('name: linux-debian-12-install-smoke');
  });
});
