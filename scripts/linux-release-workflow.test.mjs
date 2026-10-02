import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(new URL('../.github/workflows/linux-release.yml', import.meta.url), 'utf8');

describe('protected Linux release candidate worker', () => {
  it('provisions the real pinned Linux Codex prerequisite before mission smoke', () => {
    const install = workflow.indexOf('node scripts/install-linux-smoke-codex.mjs');
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(workflow.indexOf('xvfb-run -a node scripts/smoke-packaged-app.mjs'));
    expect(workflow).toContain('name: linux-codex-smoke-prerequisite');
  });
  it('accepts only explicit dispatch from protected canonical main and never publishes', () => {
    expect(workflow).toContain('name: Linux x64 release');
    expect(workflow).toContain("github.repository == 'Hiper-nexus/nexus-ide'");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("github.ref == 'refs/heads/main' && github.ref_protected");
    expect(workflow).toContain('.protected == true and .commit.sha == $sha');
    expect(workflow).toContain('runs-on: ubuntu-22.04');
    expect(workflow).not.toMatch(/pull_request:|contents: write|gh release|release:publish/);
    const runs = [...workflow.matchAll(/\n        run: \|\n([\s\S]*?)(?=\n      - |$)/g)].map((match) => match[1]);
    for (const run of runs) expect(run).not.toContain('${{ inputs.');
  });

  it('binds an annotated tag to main ancestry before executing source scripts', () => {
    expect(workflow).toContain('test "$(git cat-file -t "$RELEASE_TAG")" = tag');
    expect(workflow).toContain('git merge-base --is-ancestor "$RELEASE_COMMIT" "$GITHUB_SHA"');
    expect(workflow).toContain('git checkout --detach "$RELEASE_COMMIT"');
    expect(workflow.indexOf('Validate annotated tag on main')).toBeLessThan(workflow.indexOf('Bootstrap repository-pinned npm'));
    expect(workflow.indexOf('Require current protected main')).toBeLessThan(workflow.indexOf('actions/checkout@'));
    expect(workflow).toContain('persist-credentials: false');
  });

  it('uses the repository runtime authority and verifies npm integrity before install', () => {
    expect(workflow).toContain('node-version: ${{ steps.source.outputs.node_version }}');
    expect(workflow).toContain('readAndAssertReleaseAuthority');
    expect(workflow).toContain('bootstrapPinnedNpm');
    expect(workflow).toContain('expectedIntegrity: authority.npmPackageIntegrity');
    expect(workflow).toContain('process.versions.node !== authority.nodeVersion');
    expect(workflow.indexOf('bootstrapPinnedNpm({')).toBeLessThan(workflow.indexOf('npm ci'));
    expect(workflow).toContain('npm run release:security');
  });

  it('requires runtime and installed-DEB proof before uploading the publisher contract', () => {
    expect(workflow).toContain('npm run make -- --platform linux --arch x64');
    expect(workflow).toContain('xvfb-run -a node scripts/smoke-packaged-app.mjs');
    expect(workflow).toContain('sudo apt-get install --no-install-recommends -y "$DEB"');
    expect(workflow).toContain("dpkg-query -W -f='${Version}' nexus-ide");
    expect(workflow).toContain('rpm -qpR "$RPM"');
    // As dependências ficam declaradas nos pacotes, não só presentes no runner.
    expect(workflow).toMatch(/dpkg-deb -f "\$DEB" Depends \| grep -Eq .*desktop-file-utils/);
    expect(workflow).toMatch(/rpm -qpR "\$RPM" \| grep -Eq '\^desktop-file-utils/);
    expect(workflow).toMatch(/rpm -qpR "\$RPM" \| grep -Eq '\^alsa-lib/);
    expect(workflow).toContain('node scripts/verify-linux-desktop-identity.mjs');
    expect(workflow.indexOf('sudo apt-get install --no-install-recommends -y "$DEB"')).toBeLessThan(workflow.indexOf('node scripts/verify-linux-desktop-identity.mjs'));
    expect(workflow).toContain('rpm -qpl "$RPM" | grep -Fxq /usr/share/applications/nexus-ide.desktop');
    expect(workflow).toContain('-f "$entry" && -x "$entry" && ! -L "$entry"');
    expect(workflow).toContain('node scripts/collect-linux-release.mjs');
    expect(workflow).toContain('python3 scripts/extract-linux-zip.py');
    expect(workflow).toContain('scripts/smoke-packaged-app.mjs --app "$ZIP_BINARY"');
    expect(workflow.indexOf('--app "$ZIP_BINARY"')).toBeLessThan(workflow.indexOf('node scripts/collect-linux-release.mjs'));
    expect(workflow.indexOf('Install DEB and verify')).toBeLessThan(workflow.indexOf('node scripts/collect-linux-release.mjs'));
    expect(workflow).toContain('name: linux-x64-release');
    expect(workflow).toContain('name: linux-x64-receipt');
    expect(workflow).toContain('path: ${{ runner.temp }}/linux-release-assets/linux-release-receipt.json');
    const executableLines = workflow.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    expect(executableLines).not.toMatch(/ELECTRON_DISABLE_SANDBOX|--no-sandbox/);
  });

  it('pins every third-party action to an immutable commit', () => {
    const actions = [...workflow.matchAll(/uses: ([^\s]+)@([^\s]+)/g)];
    expect(actions.length).toBeGreaterThan(0);
    for (const [, , ref] of actions) expect(ref).toMatch(/^[a-f0-9]{40}$/);
  });
});
