import { describe, expect, it } from 'vitest';
import {
  boundedConfirmationArgs,
  boundedConfirmationLine,
  estimateRenderedLines,
  MAX_CONFIRMATION_ARGUMENT_RENDERED_LINES,
  MAX_CONFIRMATION_LINE_CHARS,
} from './confirmation-format';

/** The dialog marker line may add up to two rendered lines on top of the cap. */
const RENDERED_LINE_HARD_CEILING = MAX_CONFIRMATION_ARGUMENT_RENDERED_LINES + 2;

describe('boundedConfirmationArgs', () => {
  it('returns small args verbatim without a truncation marker', () => {
    const out = boundedConfirmationArgs({ action: 'plan', missionId: 'm-1' });
    expect(out).toBe(
      JSON.stringify({ action: 'plan', missionId: 'm-1' }, null, 2),
    );
    expect(out).not.toContain('[truncado');
  });

  it('keeps a Maestro-sized nexus_task plan within the height budget', () => {
    // Caso de campo 18/07: action:plan com detail gigante por task tornou o
    // NSAlert mais alto que a tela e os botões inalcançáveis.
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      title: `T${index + 1} — Perda de login com 2 contas Claude (item do MD)`,
      detail: `Implementar em src/main: ${'re-capturar readActiveClaudeCredential para o vault; '.repeat(20)}`,
      ownership: {
        files: [
          'src/main/persistence/account-store.ts',
          'src/main/adapters/claude-credential.ts',
          'src/main/quota/claude-oauth-refresh.ts',
        ],
      },
    }));
    const out = boundedConfirmationArgs({
      action: 'plan',
      missionId: 'mission-721ddcc2-2e70-480a-ad1b-961d84892dbf',
      tasks,
    });
    expect(out).toContain('[truncado');
    expect(out).toContain('audit log');
    expect(estimateRenderedLines(out)).toBeLessThanOrEqual(
      RENDERED_LINE_HARD_CEILING,
    );
  });

  it('bounds many short lines even when under the character cap', () => {
    const out = boundedConfirmationArgs({
      items: Array.from({ length: 200 }, () => 'x'),
    });
    expect(out).toContain('[truncado');
    expect(estimateRenderedLines(out)).toBeLessThanOrEqual(
      RENDERED_LINE_HARD_CEILING,
    );
  });

  it('clips long leaf strings and marks the output as truncated', () => {
    const out = boundedConfirmationArgs({ detail: 'a'.repeat(1_000) });
    expect(out).toContain(`"${'a'.repeat(160)}…"`);
    expect(out).toContain('[truncado');
  });

  it('still redacts secret-bearing keys before display', () => {
    const out = boundedConfirmationArgs({
      token: 'super-secret-value',
      command: 'echo ok',
    });
    expect(out).not.toContain('super-secret-value');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('echo ok');
  });
});

describe('boundedConfirmationLine', () => {
  it('collapses newlines so one field cannot add extra dialog lines', () => {
    expect(boundedConfirmationLine('run command:\n\n  npm test')).toBe(
      'run command: npm test',
    );
  });

  it('caps a giant reason such as a full terminal command', () => {
    const out = boundedConfirmationLine(`run command: ${'x'.repeat(2_000)}`);
    expect(out).toHaveLength(MAX_CONFIRMATION_LINE_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});
