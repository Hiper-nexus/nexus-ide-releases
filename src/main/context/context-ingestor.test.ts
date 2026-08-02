import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ensureContextScaffold } from './context-doctor';
import { ingestProjectContext } from './context-ingestor';
import { DESIGN_SYSTEM_CANDIDATE_PATHS } from '../orch/design-system-reader';

describe('ingestProjectContext DESIGN.md adapter', () => {
  let root = '';
  let scope: ProjectExecutionScope;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ingestor-')));
    scope = Object.freeze({
      version: 1,
      installationId: 'install-ingestor',
      projectId: 'project-ingestor',
      checkoutId: 'checkout-ingestor',
      rootRealPath: root,
      identitySource: 'manifest',
    });
    ensureContextScaffold(scope);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('extracts facts from both DESIGN.md and design-system.md', () => {
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'DESIGN.md'),
      '# DESIGN.md\n\n## Color Palette\n- Primary: #3b82f6\n',
    );
    fs.writeFileSync(
      path.join(root, '.context', 'docs', 'design-system.md'),
      '# Imported design system\n\n## Typography\n- Font family: Inter\n',
    );

    const corpus = ingestProjectContext(scope);
    const claimKeys = corpus.facts.map((fact) => fact.claimKey).sort();

    expect(claimKeys).toEqual(['color-primary', 'typography-font-family']);
    expect(corpus.facts.every((fact) => fact.projectId === scope.projectId)).toBe(true);
  });

  // Mechanical alignment guard: whatever path the single workspace resolver
  // can answer with, the ingestor must also see. If a future candidate is
  // added to the resolver and not covered here, a contract could be delivered
  // to the worker while the context corpus stays blind to it.
  it.each([...DESIGN_SYSTEM_CANDIDATE_PATHS])(
    'extracts design facts from the resolver candidate %s',
    (candidate) => {
      const absolute = path.join(root, candidate);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, '# Contract\n\n## Color Palette\n- Primary: #3b82f6\n');

      const corpus = ingestProjectContext(scope);

      expect(corpus.facts.map((fact) => fact.claimKey)).toEqual(['color-primary']);
      expect(corpus.facts[0]?.source.locator).toBe(candidate);
    },
  );

  it('ignores documents that are not canonical design files', () => {
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.context', 'docs', 'business-model.md'),
      '# Business\n- Primary: #3b82f6\n',
    );

    const corpus = ingestProjectContext(scope);

    expect(corpus.facts).toEqual([]);
  });
});
