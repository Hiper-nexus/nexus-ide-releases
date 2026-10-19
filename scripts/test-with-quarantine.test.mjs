import { describe, expect, it } from 'vitest';
import { classifyVitestReport, formatQuarantineReport, parseQuarantine } from './test-with-quarantine.mjs';

describe('test-with-quarantine', () => {
  it('separa somente falhas explicitamente listadas e mantém as novas bloqueando', () => {
    const quarantine = parseQuarantine({
      version: 1,
      tests: [{ file: 'src/known.test.ts', reason: 'Falha de infraestrutura confirmada na main.' }],
    });
    const result = classifyVitestReport({
      testResults: [
        { name: '/repo/src/known.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }] },
        { name: '/repo/src/new.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }] },
      ],
    }, quarantine, '/repo');
    expect(result).toEqual({
      quarantined: [{ file: 'src/known.test.ts', reason: 'Falha de infraestrutura confirmada na main.' }],
      newFailures: [{ file: 'src/new.test.ts' }],
    });
    expect(formatQuarantineReport(result)).toContain('1 falha(s) em quarentena; 1 falha(s) nova(s).');
  });

  it('recusa curingas, caminhos ascendentes e motivos vazios', () => {
    expect(() => parseQuarantine({ version: 1, tests: [{ file: '../all.test.ts', reason: 'motivo suficientemente longo' }] })).toThrow();
    expect(() => parseQuarantine({ version: 1, tests: [{ file: '*.test.ts', reason: 'motivo suficientemente longo' }] })).toThrow();
  });
});
