import { describe, expect, it } from 'vitest';
import { pickModelRotation, routeModelsForAdapter } from './failover';

describe('F-765: alternativa elegível quando o recusado é o default', () => {
  const codexList = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra'];

  it('a rota automática da CLI vem do tier mais forte e nunca traz o Astra (F-700)', () => {
    const models = routeModelsForAdapter('codex');
    expect(models[0]).toBe('gpt-6.1-sol');
    expect(models).toContain('gpt-6-sol');
    expect(models).not.toContain('gpt-6-astra');
  });

  it('default recusado com outro modelo elegível → troca para o próximo da rota', () => {
    expect(pickModelRotation('gpt-6.1-sol', 'gpt-6.1-sol', {
      candidates: routeModelsForAdapter('codex'),
      available: codexList,
    })).toBe('gpt-6-sol');
  });

  it('recusados/quarentenados e modelos fora da CLI instalada ficam de fora', () => {
    const quarantined = new Set(['gpt-6.1-sol', 'gpt-6-sol']);
    expect(pickModelRotation('gpt-6-sol', 'gpt-6.1-sol', {
      candidates: routeModelsForAdapter('codex'),
      available: codexList,
      eligible: (model) => !quarantined.has(model),
    })).toBe('gpt-5.6-sol');
    // Lista da CLI sem o candidato: nunca emite modelo que ela não roda.
    expect(pickModelRotation('gpt-6.1-sol', 'gpt-6.1-sol', {
      candidates: ['gpt-6-sol', 'gpt-5.6-sol'],
      available: ['gpt-6.1-sol', 'gpt-5.6-sol'],
    })).toBe('gpt-5.6-sol');
  });

  it('duas rejeições não criam laço: tudo recusado → sem rotação', () => {
    const refused = new Set<string>();
    const options = () => ({
      candidates: routeModelsForAdapter('codex'),
      available: codexList,
      eligible: (model: string) => !refused.has(model),
    });
    let current: string | undefined = 'gpt-6.1-sol';
    const seen: string[] = [];
    while (current) {
      refused.add(current);
      seen.push(current);
      current = pickModelRotation(current, 'gpt-6.1-sol', options());
      expect(seen).not.toContain(current);
    }
    expect(seen.length).toBeGreaterThan(2);
    expect(seen).not.toContain('gpt-6-astra');
  });
});

describe('pickModelRotation (F-520: failover de modelo, conta sadia)', () => {
  it('migra id aposentado para a linhagem ativa', () => {
    expect(pickModelRotation('gemini-3.5-flash-high', 'gemini-3.8-flash-high')).toBe(
      'gemini-3.8-flash-high',
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

  it('pane sem modelo explícito não rotaciona: já roda no default do adapter', () => {
    // Respawnar "no default" repetiria o mesmo modelo rejeitado com toast de
    // sucesso — a orientação certa (atualizar CLI) vem do toast bloqueado.
    expect(pickModelRotation(undefined, 'gemini-3.8-flash-high')).toBeUndefined();
    expect(pickModelRotation(undefined, undefined)).toBeUndefined();
  });
});
