import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { designContractInspectionLines } from './cli-automated-reviewer';
import {
  DESIGN_SYSTEM_CANDIDATE_PATHS,
} from '../orch/design-system-reader';
import { DEFAULT_DESIGN_TARGET_PATH } from '../orch/design-system-authority';

/**
 * H2 regression guard: the reviewer used to be ordered to `Read DESIGN.md`
 * while the bootstrap materialized `.context/docs/design-system.md`. It read a
 * file that did not exist and approved the delivery anyway.
 */
describe('the visual reviewer is sent to the file that exists', () => {
  let checkout = '';

  beforeEach(() => {
    checkout = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-review-design-')),
    );
  });

  afterEach(() => {
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  it('names the materialized path when only .context/docs/design-system.md exists', () => {
    fs.mkdirSync(path.join(checkout, '.context', 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, '.context', 'docs', 'design-system.md'),
      '# Contrato\n',
    );

    const lines = designContractInspectionLines(checkout).join('\n');

    expect(lines).toContain(`\`${DEFAULT_DESIGN_TARGET_PATH}\``);
    expect(lines).not.toContain('Read DESIGN.md');
    expect(lines).toMatch(/rendered implementation/i);
  });

  it('names the root convention when DESIGN.md exists', () => {
    fs.writeFileSync(path.join(checkout, 'DESIGN.md'), '# Raiz\n');

    const lines = designContractInspectionLines(checkout).join('\n');

    expect(lines).toContain('`DESIGN.md`');
    expect(lines).toMatch(/rendered implementation/i);
  });

  it('refuses to order a read of a missing file and makes the gap a finding', () => {
    const lines = designContractInspectionLines(checkout).join('\n');

    expect(lines).not.toMatch(/Read (the workspace design contract at )?`?DESIGN\.md`?/);
    for (const candidate of DESIGN_SYSTEM_CANDIDATE_PATHS) {
      expect(lines).toContain(candidate);
    }
    expect(lines).toMatch(/no design contract/i);
    expect(lines).toMatch(/finding/i);
    expect(lines).toMatch(/rendered implementation/i);
  });
});
