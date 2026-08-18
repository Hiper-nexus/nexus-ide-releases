import { describe, expect, it } from 'vitest';

import { spawnFailureGuidance } from './spawn-failure-guidance';

describe('spawnFailureGuidance', () => {
  it('traduz a recusa de ownership do supervisor (bundle trocado com app aberto)', () => {
    const guidance = spawnFailureGuidance(
      'Packaged Darwin PTY responsibility supervisor failed application-' +
        'ownership verification: application bundle does not own the running ' +
        'main/utility code chain',
    );
    expect(guidance).not.toBeNull();
    expect(guidance).toContain('feche e reabra o Nexus');
    expect(guidance).toContain('atualizado em disco');
  });

  it('traduz o executável vivo fora do bundle corrente (realpath divergente)', () => {
    const guidance = spawnFailureGuidance(
      'running executable is not the exact main/utility image inside this bundle',
    );
    expect(guidance).not.toBeNull();
    expect(guidance).toContain('feche e reabra o Nexus');
  });

  it('traduz falha de assinatura como instalação corrompida, não hot-swap', () => {
    const guidance = spawnFailureGuidance(
      'Packaged Darwin PTY responsibility supervisor failed application-' +
        'ownership verification: helper and application must both carry ' +
        'Nexus Team ID 35P5XL3JN6',
    );
    expect(guidance).not.toBeNull();
    expect(guidance).toContain('reinstale');
    expect(guidance).not.toContain('feche e reabra o Nexus');
  });

  it('retorna null para erro desconhecido (não inventa orientação)', () => {
    expect(spawnFailureGuidance('spawn ENOENT')).toBeNull();
    expect(spawnFailureGuidance('')).toBeNull();
  });
});
