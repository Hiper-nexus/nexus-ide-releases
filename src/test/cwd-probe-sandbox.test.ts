import { describe, expect, it } from 'vitest';
import { cwdProbeSandboxEvidence } from './cwd-probe-sandbox';

const eperm = Object.assign(new Error('spawnSync /bin/ps EPERM'), { code: 'EPERM' });

describe('sonda de cwd real sob o Seatbelt do portão', () => {
  it('pula só com o ps setuid recusado (EPERM) e exec comum funcionando, no macOS', () => {
    expect(cwdProbeSandboxEvidence({ platform: 'darwin', psSpawnError: eperm, plainExecOk: true }))
      .toMatch(/\/bin\/ps \(setuid\) recusado com spawn EPERM/);
  });

  it('não pula com ps que roda, que falha de outro jeito, exec comum também negado ou fora do macOS', () => {
    expect(cwdProbeSandboxEvidence({ platform: 'darwin', psSpawnError: undefined, plainExecOk: true })).toBeUndefined();
    expect(cwdProbeSandboxEvidence({ platform: 'darwin', psSpawnError: Object.assign(new Error('x'), { code: 'ENOENT' }), plainExecOk: true }))
      .toBeUndefined();
    expect(cwdProbeSandboxEvidence({ platform: 'darwin', psSpawnError: eperm, plainExecOk: false })).toBeUndefined();
    expect(cwdProbeSandboxEvidence({ platform: 'linux', psSpawnError: eperm, plainExecOk: true })).toBeUndefined();
  });
});
