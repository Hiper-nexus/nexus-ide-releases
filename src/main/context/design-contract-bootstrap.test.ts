import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import type { ProjectExecutionScope } from '../../shared/types';
import { buildDesignContractBootstrap } from './design-contract-bootstrap';

/**
 * Real filesystem, no mocks: the whole point of this builder is that its
 * output is a deterministic function of what is actually on disk, and a mocked
 * disk would prove nothing about the re-derivation the reviewer performs.
 */
let root: string;
let catalogDir: string;
let scope: ProjectExecutionScope;

const UI_GOAL = 'redesign da interface do dashboard de metricas';
const BACKEND_GOAL = 'implementar o endpoint de sincronizacao no servidor';

function writeCatalogKit(kitId: string, description: string): void {
  fs.writeFileSync(
    path.join(catalogDir, `${kitId}.md`),
    `---\nname: ${kitId}\ndescription: "${description}"\n---\n\n# ${kitId}\n\nbody\n`,
    'utf8',
  );
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-bootstrap-')),
  );
  catalogDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-catalog-')),
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'acme-console', version: '1.0.0' }, null, 2)}\n`,
    'utf8',
  );
  scope = testProjectScope({ rootRealPath: root });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(catalogDir, { recursive: true, force: true });
});

describe('buildDesignContractBootstrap', () => {
  it('materializes a source-bound contract with declared provenance for a UI goal with no contract', async () => {
    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(decision.skipReason).toBeNull();
    const proposal = decision.proposal;
    if (!proposal) throw new Error('expected a proposal');
    expect(proposal.targetPath).toBe('.context/docs/design-system.md');
    expect(proposal.sources).toEqual([
      {
        type: 'file',
        locator: 'package.json',
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    // Provenance is declared, not implied.
    expect(proposal.content).toContain(
      '<!-- contract-kind: nexus-house-design-contract-v1 -->',
    );
    expect(proposal.content).toContain('<!-- bound-source: package.json -->');
    expect(proposal.content).toContain('# Design contract — acme-console');
    // The dembrandt hard rule travels inside every contract Nexus writes.
    expect(proposal.content).toContain(
      'Never copy a third-party brand, logo, or wordmark.',
    );
    // Nothing may look auto-reviewable-by-placeholder.
    expect(proposal.content).not.toMatch(/\bTODO\b/);
  });

  it('does nothing for a backend goal', async () => {
    const decision = await buildDesignContractBootstrap({
      scope,
      goal: BACKEND_GOAL,
      catalogDir,
    });

    expect(decision.proposal).toBeNull();
    expect(decision.skipReason).toBe('not-visual-work');
  });

  it('does nothing when the goal is visual but the classifier is not confident', async () => {
    // Visual craft AND a defect repair claim compete, so classifyWorkKind
    // returns low confidence. Forcing a design contract onto an ambiguous goal
    // is worse than leaving the decision to the mission.
    const decision = await buildDesignContractBootstrap({
      scope,
      goal: 'corrigir o bug de layout que quebra o css do modal',
      catalogDir,
    });

    expect(decision.workKind?.kind).toBe('bug');
    expect(decision.proposal).toBeNull();
    expect(decision.skipReason).toBe('not-visual-work');
  });

  it('lets the explicit setting beat the signal match', async () => {
    writeCatalogKit(
      'ledgerkit',
      'A financial-infrastructure brand for payments and money movement.',
    );
    writeCatalogKit(
      'panelkit',
      'A dense dashboard and analytics system with metrics and charts.',
    );

    const matched = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });
    expect(matched.choice?.mode).toBe('match');
    expect(
      matched.choice?.mode === 'match' && matched.choice.kit.kitId,
    ).toBe('panelkit');

    const pinned = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      pinnedKitId: 'ledgerkit',
      catalogDir,
    });
    expect(pinned.choice?.mode).toBe('setting');
    expect(pinned.choice?.mode === 'setting' && pinned.choice.kit.kitId).toBe(
      'ledgerkit',
    );
    expect(pinned.proposal?.content).toContain(
      'Chosen by **explicit operator setting**',
    );
  });

  it('declares the match and its confidence, binds the kit by hash, and copies none of its content', async () => {
    writeCatalogKit(
      'panelkit',
      'A dense dashboard and analytics system with metrics and charts.',
    );

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    const content = decision.proposal?.content ?? '';
    expect(content).toContain('<!-- direction: signal-match -->');
    expect(content).toContain('<!-- direction-matched-axes: dashboard -->');
    expect(content).toContain('<!-- direction-confidence: low -->');
    expect(content).toMatch(/direction-kit-sha256: [a-f0-9]{64}/);
    expect(content).toContain('Chosen by **signal match**, not by a human');
    // The kit's own prose never becomes project authority: only its id, its
    // path and its hash cross the boundary.
    expect(content).not.toContain('A dense dashboard and analytics system');
  });

  it('neutralizes markup in third-party kit metadata before it enters authority', async () => {
    // The catalog is operator-supplied text. A title carrying backticks could
    // restructure the document an agent later reads as authority.
    fs.writeFileSync(
      path.join(catalogDir, 'panelkit.md'),
      '---\nname: "pane`kit` <!-- x -->"\ndescription: "A dense dashboard and analytics system with metrics."\n---\n\n# panelkit\n',
      'utf8',
    );

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    const content = decision.proposal?.content ?? '';
    // The catalog now refuses a title that does not look like a NAME and falls
    // back to the (already sanitized) file name, so the hostile string never
    // reaches the document at all. The invariant the test guards is unchanged:
    // no operator-supplied text may restructure a document an agent obeys.
    expect(content).toContain('`panelkit`');
    expect(content).not.toContain('pane`kit`');
    expect(content).not.toContain('<!-- x -->');
    // A `<!--` smuggled through the title would hide the whole token floor
    // from any renderer: every comment opener must be one Nexus wrote.
    expect(content.match(/<!--/g)?.length).toBe(
      content.match(/-->/g)?.length,
    );
    expect(content).toContain('## Token floor');
  });

  it('writes a contract declared as neutral when no signal matches', async () => {
    writeCatalogKit(
      'ledgerkit',
      'A financial-infrastructure brand for payments and money movement.',
    );

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: 'redesign da tela de configuracoes',
      catalogDir,
    });

    const content = decision.proposal?.content ?? '';
    expect(decision.choice?.mode).toBe('neutral');
    expect(content).toContain('<!-- direction: neutral-house-baseline -->');
    expect(content).toContain('<!-- direction-reason: no-domain-signal -->');
    expect(content).toContain(
      '## Visual direction — NONE CHOSEN (neutral house baseline)',
    );
    expect(content).toContain('This contract is **neutral**');
    // A neutral contract must not name any third-party kit.
    expect(content).not.toContain('ledgerkit');
  });

  it('refuses to substitute another brand for a pinned kit that is missing', async () => {
    writeCatalogKit(
      'ledgerkit',
      'A financial-infrastructure brand for payments and money movement.',
    );

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: 'redesign da interface de pagamentos do checkout',
      pinnedKitId: 'not-in-this-catalog',
      catalogDir,
    });

    expect(decision.choice?.mode).toBe('neutral');
    expect(decision.proposal?.content).toContain(
      '<!-- direction-reason: pinned-kit-unavailable -->',
    );
    expect(decision.proposal?.content).not.toContain('ledgerkit');
  });

  it('never overwrites an existing contract at the root', async () => {
    fs.writeFileSync(path.join(root, 'DESIGN.md'), '# Our design\n', 'utf8');

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(decision.proposal).toBeNull();
    expect(decision.skipReason).toBe('contract-exists');
    expect(decision.existingContractPath).toBe('DESIGN.md');
  });

  it('never overwrites an existing contract at the context target path', async () => {
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.context', 'docs', 'design-system.md'),
      '# Our design\n',
      'utf8',
    );

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(decision.proposal).toBeNull();
    expect(decision.skipReason).toBe('contract-exists');
    expect(decision.existingContractPath).toBe('.context/docs/design-system.md');
  });

  it('proposes nothing when no workspace file can be bound as evidence', async () => {
    fs.rmSync(path.join(root, 'package.json'));

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(decision.proposal).toBeNull();
    expect(decision.skipReason).toBe('no-bindable-source');
  });

  it('binds a product doc and asserts no project name when package.json is absent', async () => {
    fs.rmSync(path.join(root, 'package.json'));
    fs.writeFileSync(path.join(root, 'README.md'), '# Acme\n', 'utf8');

    const decision = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(decision.proposal?.sources[0]?.locator).toBe('README.md');
    expect(decision.proposal?.content).toContain('\n# Design contract\n');
  });

  it('is byte-deterministic, which is what the mechanical reviewer re-derives', async () => {
    writeCatalogKit(
      'panelkit',
      'A dense dashboard and analytics system with metrics and charts.',
    );

    const first = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });
    const second = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(second.proposal?.content).toBe(first.proposal?.content);
    expect(second.proposal?.sources).toEqual(first.proposal?.sources);
  });

  it('changes bytes when the referenced kit file changes, so a stale draft cannot pass review', async () => {
    writeCatalogKit(
      'panelkit',
      'A dense dashboard and analytics system with metrics and charts.',
    );
    const before = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    writeCatalogKit(
      'panelkit',
      'A dense dashboard and analytics system with metrics, charts and tables.',
    );
    const after = await buildDesignContractBootstrap({
      scope,
      goal: UI_GOAL,
      catalogDir,
    });

    expect(after.proposal?.content).not.toBe(before.proposal?.content);
  });
});
