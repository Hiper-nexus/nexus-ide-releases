import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('decision evaluation CLI', () => {
  it('rejects credential arguments instead of accepting secrets into shell history', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/evaluate-decision-models.mjs', '--token', 'synthetic-private-token'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Credenciais');
    expect(result.stderr).not.toContain('synthetic-private-token');
  });
});
