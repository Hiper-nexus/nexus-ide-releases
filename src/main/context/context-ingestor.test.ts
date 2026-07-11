import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ensureContextScaffold } from './context-doctor';
import { ingestProjectContext } from './context-ingestor';

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
