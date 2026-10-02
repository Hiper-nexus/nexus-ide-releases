import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
const text = fs.readFileSync(new URL('../.github/workflows/macos-preview.yml', import.meta.url), 'utf8');
const workflow = parse(text);
const job = workflow.jobs.build;
const runs = job.steps.filter((step) => step.run).map((step) => step.run);

describe('macOS preview authority and runtime proof', () => {
  it('uses read-only main/PR sources without publication or signing credentials', () => {
    expect(workflow.on).toEqual({ push: { branches: ['main'] }, pull_request: { branches: ['main'] } });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job['runs-on']).toBe('macos-15');
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with.ref).toBe('${{ github.sha }}');
    expect(checkout.with['persist-credentials']).toBe(false);
    expect(text).not.toMatch(/pull_request_target|contents: write|secrets\.|APPLE_|NEXUS_MAC_PUBLISH_RELEASE|release:publish|release:candidate|notarytool|refs\/tags/);
    for (const step of job.steps.filter((step) => step.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  });
  it('makes package collection depend on exact runtime, prerequisite and complete app/ZIP proof', () => {
    const order = ['bootstrapPinnedNpm', 'node scripts/install-macos-smoke-codex.mjs', 'npm ci', 'npm run typecheck', 'npm run make -- --platform darwin --arch arm64', 'await runPackagedSmoke', 'schema: \'nexus.macos-preview/v1\''];
    for (let i = 1; i < order.length; i += 1) expect(text.indexOf(order[i])).toBeGreaterThan(text.indexOf(order[i - 1]));
    expect(text).toContain('expectedIntegrity: authority.npmPackageIntegrity');
    expect(text).toContain("['app', app], ['zip', path.join(extracted, 'NexusIDE.app')]");
    expect(text).toContain('Number(count[1]) !== FUNCTIONAL_SMOKE_REQUIRED_PROBES.length');
    expect(text).toContain("result.shutdownMode !== 'graceful'");
    expect(text).toContain('!result.treeProof?.ok');
    expect(text).toContain('publishable: false, releaseEligible: false');
    expect(text).toContain('notarizationRequested: false');
    const upload = job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload.every((step) => step.with.name.startsWith('macos-arm64-preview'))).toBe(true);
    expect(upload.at(-1).if).toBeUndefined();
  });
  it('keeps every hosted shell step syntactically valid without executing it', () => {
    for (const run of runs) {
      const result = spawnSync('bash', ['-n'], { input: run, encoding: 'utf8', shell: false });
      expect(result.status, result.stderr).toBe(0);
    }
  });
});
