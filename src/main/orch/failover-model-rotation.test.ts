import { describe, expect, it } from 'vitest';
import { pickModelRotation } from './failover';

describe('pickModelRotation (F-520: failover de modelo, conta sadia)', () => {
  it('migra id aposentado para a linhagem ativa', () => {
    expect(pickModelRotation('gemini-3.1-pro-high', 'gemini-3.8-pro-high')).toBe(
      'gemini-3.8-pro-high',
    );
    expect(pickModelRotation('gpt-5.4-pro', 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('cai para o default curado do adapter quando o id não tem migração', () => {
    // Caso central do bug: gpt-6-astra rejeitado por CLI desatualizada — o id
    // em si não é migrável, a rotação é para o frontier default do catálogo.
    expect(pickModelRotation('gpt-6-astra', 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('não rotaciona quando o modelo rejeitado já é o default do adapter', () => {
    // Sem alternativa no catálogo: o pane recebe orientação (atualizar CLI)
    // em vez de um respawn no mesmo modelo que acabou de ser rejeitado.
    expect(pickModelRotation('gpt-5.6-sol', 'gpt-5.6-sol')).toBeUndefined();
  });

  it('pane sem modelo explícito roda para o default do adapter', () => {
    expect(pickModelRotation(undefined, 'gemini-3.8-pro-high')).toBe(
      'gemini-3.8-pro-high',
    );
    expect(pickModelRotation(undefined, undefined)).toBeUndefined();
  });
});
