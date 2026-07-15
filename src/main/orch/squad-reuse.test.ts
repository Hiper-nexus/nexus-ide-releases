import { describe, expect, it } from 'vitest';
import { pickReusableSquad, type ReusableSquadLike } from './squad-reuse';

function squad(
  id: string,
  createdAt: number,
  clis: string[],
  builtin = false,
): ReusableSquadLike {
  return {
    id,
    builtin,
    createdAt: String(createdAt),
    agents: clis.map((cli) => ({ cli })),
  };
}

const installed = new Set(['claude', 'kimi', 'agy', 'codex']);

describe('pickReusableSquad', () => {
  it('reusa o squad de usuário mais recente com todos os clis instalados', () => {
    const older = squad('meu-time-antigo', 1_000, ['claude', 'kimi']);
    const newer = squad('meu-time-novo', 2_000, ['claude', 'agy', 'codex']);
    expect(pickReusableSquad([older, newer], installed)?.id).toBe('meu-time-novo');
  });

  it('ignora squads builtin (gerenciados pelo app)', () => {
    const builtin = squad('nexus-full', 5_000, ['claude'], true);
    const user = squad('meu-time', 1_000, ['claude', 'kimi']);
    expect(pickReusableSquad([builtin, user], installed)?.id).toBe('meu-time');
  });

  it('ignora fallbacks agênticos auto-gerados (não congela um fallback velho)', () => {
    const fallback = squad('agentic-fallback-1784118710650', 9_000, ['claude']);
    const user = squad('meu-time', 1_000, ['claude', 'kimi']);
    expect(pickReusableSquad([fallback, user], installed)?.id).toBe('meu-time');
  });

  it('ignora TODOS os squads auto-gerados: agentic-<nome> (LLM) e custom-<workspace>', () => {
    const agenticLlm = squad('agentic-time-web-1784118999999', 9_000, ['claude']);
    const customWs = squad('custom-nexus-ide', 8_000, ['claude']);
    const user = squad('meu-time', 1_000, ['claude', 'kimi']);
    expect(pickReusableSquad([agenticLlm, customWs, user], installed)?.id).toBe(
      'meu-time',
    );
    expect(pickReusableSquad([agenticLlm, customWs], installed)).toBeNull();
  });

  it('ignora squad com cli não instalado (evita worker parado em prompt de login)', () => {
    const withMissing = squad('time-glm', 9_000, ['claude', 'glm']);
    const healthy = squad('meu-time', 1_000, ['claude', 'kimi']);
    expect(pickReusableSquad([withMissing, healthy], installed)?.id).toBe('meu-time');
  });

  it('ignora squad com roster vazio', () => {
    const empty = squad('vazio', 9_000, []);
    expect(pickReusableSquad([empty], installed)).toBeNull();
  });

  it('retorna null quando nada qualifica', () => {
    const builtin = squad('nexus-full', 5_000, ['claude'], true);
    const broken = squad('time-glm', 6_000, ['glm']);
    expect(pickReusableSquad([builtin, broken], installed)).toBeNull();
  });

  it('ordena corretamente com createdAt ISO string (schema permite ISO ou epoch-ms)', () => {
    const epochOld: ReusableSquadLike = {
      id: 'epoch-antigo',
      builtin: false,
      createdAt: '1000',
      agents: [{ cli: 'claude' }],
    };
    const isoNewer: ReusableSquadLike = {
      id: 'iso-novo',
      builtin: false,
      createdAt: '2026-07-11T00:00:00.000Z',
      agents: [{ cli: 'kimi' }],
    };
    expect(pickReusableSquad([epochOld, isoNewer], installed)?.id).toBe('iso-novo');
    expect(pickReusableSquad([isoNewer, epochOld], installed)?.id).toBe('iso-novo');
  });

  it('ISO antigo perde para epoch-ms recente', () => {
    const isoOld: ReusableSquadLike = {
      id: 'iso-2001',
      builtin: false,
      createdAt: '2001-01-01T00:00:00.000Z',
      agents: [{ cli: 'claude' }],
    };
    // Epoch-ms de 2026 > ISO de 2001 na linha do tempo real.
    const epochNewer: ReusableSquadLike = {
      id: 'epoch-2026',
      builtin: false,
      createdAt: '1784118710650',
      agents: [{ cli: 'kimi' }],
    };
    expect(pickReusableSquad([isoOld, epochNewer], installed)?.id).toBe('epoch-2026');
  });
});
