import { describe, expect, it } from 'vitest';
import {
  buildContinuityPack,
  buildSameAccountContinuePrompt,
  MAX_CONTINUITY_PACK_CHARS,
} from './failover-continuity';
import { detectLimit } from '../../main/orch/limit-detector';
import {
  FAILOVER_HANDOFF_FOOTER,
  FAILOVER_HANDOFF_HEADER,
} from '../../shared/failover-handoff';
import { maskAccountLabel } from '../../shared/account-choice';

/** Scrollback fixo: início entediante, fim é onde está o estado real. */
const FIXED_SCROLLBACK = [
  'boot…',
  'compiling module a',
  'compiling module b',
  'editing src/shared/failover-handoff.ts',
  'API Error: 401 Unauthorized — usage limit reached',
  'last line before death',
].join('\n');

const RICH_INPUT = {
  fromAccountLabel: 'gustavo.lupygo@example.com',
  toAccountLabel: 'ana.ops@example.org',
  reason: "You've hit your 5-hour usage limit · status: 401",
  role: 'worker' as const,
  missionId: 'mission-775',
  taskBrief: 'Ship F-775 continuity pack with masked labels',
  openWorkHint: 'mission-775: F-775 failover continuity',
  limitKind: 'rate-limit',
  limitWindow: '5 Horas',
  limitResetsAt: Date.UTC(2026, 9, 3, 18, 0, 0),
  touchedFiles: [
    'src/shared/failover-handoff.ts',
    'src/renderer/orch/failover-continuity.ts',
  ],
  diffStat: 'src/shared/failover-handoff.ts | 120 ++++++++++++--\n2 files changed',
  nextStep: 'Run vitest on failover-continuity and fix any detector drift',
  scrollbackExcerpt: FIXED_SCROLLBACK,
};

describe('failover continuity pack', () => {
  it('states new session and does not claim native resume across accounts', () => {
    const pack = buildContinuityPack({
      fromAccountLabel: 'Work',
      toAccountLabel: 'Personal',
      reason: '5-hour usage limit',
      role: 'orchestrator',
      missionId: 'm-1',
      openWorkHint: 'task: ship failover',
      scrollbackExcerpt: 'Building…\nLIMIT',
    });
    expect(pack).toMatch(/NEW provider session/i);
    expect(pack).toMatch(/NOT transferable/i);
    expect(pack).toContain(maskAccountLabel('Work'));
    expect(pack).toContain(maskAccountLabel('Personal'));
    expect(pack).toContain('m-1');
    expect(pack).toContain('ship failover');
    expect(pack).not.toMatch(/--resume/i);
  });

  it('reason line never re-arms the limit detector once the header scrolls off', () => {
    // Regressão: a 2ª linha trazia "(status: 401)" verbatim; quando a TUI
    // re-renderizava o pack sem o header na janela, o detector recasava o 401
    // citado e o failover entrava em loop entre contas saudáveis.
    for (const reason of ['status: 401', 'HTTP 429 Too Many Requests', 'authentication_error']) {
      const pack = buildContinuityPack({
        fromAccountLabel: 'retorno',
        toAccountLabel: 'Conta Claude',
        reason,
        role: 'orchestrator',
      });
      const withoutHeader = pack.replace(FAILOVER_HANDOFF_HEADER, '');
      expect(detectLimit(withoutHeader)).toBeNull();
      // Um erro NOVO do provider continua detectável após o histórico.
      expect(detectLimit(`${withoutHeader}\nAPI Error: 401 Unauthorized`)?.kind).toBe('auth');
    }
  });

  it('same-account continue is short and role-aware', () => {
    expect(buildSameAccountContinuePrompt('orchestrator')).toMatch(
      /orchestrator/,
    );
    expect(buildSameAccountContinuePrompt()).toMatch(/agent/);
  });

  // ---- F-775: pacote estruturado -----------------------------------------

  it('pack estruturado traz motivo mascarado, janela/reset, arquivos, diff e próximo passo', () => {
    const pack = buildContinuityPack(RICH_INPUT);

    // (a) motivo + janela/reset medidos, rótulos de conta mascarados.
    expect(pack).toContain(maskAccountLabel('gustavo.lupygo@example.com'));
    expect(pack).toContain(maskAccountLabel('ana.ops@example.org'));
    expect(pack).not.toContain('gustavo.lupygo@example.com');
    expect(pack).not.toContain('ana.ops@example.org');
    expect(pack).toContain('kind rate-limit');
    expect(pack).toContain('window 5 Horas');
    expect(pack).toContain(new Date(RICH_INPUT.limitResetsAt).toISOString());

    // (b) estado da tarefa.
    expect(pack).toContain('Ship F-775 continuity pack');
    expect(pack).toContain('src/shared/failover-handoff.ts');
    expect(pack).toContain('src/renderer/orch/failover-continuity.ts');
    expect(pack).toContain('2 files changed');
    // Último trecho relevante do scrollback (o fim, não o boot).
    expect(pack).toContain('last line before death');
    expect(pack).toContain('editing src/shared/failover-handoff.ts');

    // (c) próximo passo concreto.
    expect(pack).toContain('Run vitest on failover-continuity');

    expect(pack.startsWith(FAILOVER_HANDOFF_HEADER)).toBe(true);
    expect(pack.endsWith(FAILOVER_HANDOFF_FOOTER)).toBe(true);
  });

  it('pack estruturado não casa NENHUM padrão de detectLimit (anti-loop F-511)', () => {
    const pack = buildContinuityPack(RICH_INPUT);
    // O pack inteiro durante o streaming…
    expect(detectLimit(pack)).toBeNull();
    // …e o pack sem o header (TUI redesenha / janela rolante avança).
    expect(detectLimit(pack.replace(FAILOVER_HANDOFF_HEADER, ''))).toBeNull();
    // Motivo agressivo em todos os campos de texto livre.
    const toxic = buildContinuityPack({
      ...RICH_INPUT,
      reason: 'status: 401 rate limit exceeded try again',
      taskBrief: 'quota exceeded · resource_exhausted · payment required',
      nextStep: 'please run /login after session expired',
      diffStat: 'file | 2 +-\nauthentication_error',
      openWorkHint: 'refresh token expired',
      scrollbackExcerpt: 'HTTP 429 Too Many Requests\ninvalid api key',
    });
    expect(detectLimit(toxic)).toBeNull();
    expect(detectLimit(toxic.replace(FAILOVER_HANDOFF_HEADER, ''))).toBeNull();
  });

  it('teto de tamanho: o pack nunca passa de MAX_CONTINUITY_PACK_CHARS e mantém header/footer', () => {
    const huge = buildContinuityPack({
      ...RICH_INPUT,
      taskBrief: 'x'.repeat(5_000),
      diffStat: 'y'.repeat(8_000),
      nextStep: 'z'.repeat(4_000),
      openWorkHint: 'w'.repeat(3_000),
      scrollbackExcerpt: 'noise\n'.repeat(2_000) + FIXED_SCROLLBACK,
    });
    expect(huge.length).toBeLessThanOrEqual(MAX_CONTINUITY_PACK_CHARS);
    expect(huge.startsWith(FAILOVER_HANDOFF_HEADER)).toBe(true);
    expect(huge.endsWith(FAILOVER_HANDOFF_FOOTER)).toBe(true);
  });

  it('rótulos curtos viram máscara opaca, nunca o texto cru', () => {
    const pack = buildContinuityPack({
      fromAccountLabel: 'Pessoal',
      toAccountLabel: 'Work',
      reason: 'rate-limit',
    });
    expect(pack).not.toContain('Pessoal');
    expect(pack).not.toContain('"Work"');
    expect(pack).toContain(maskAccountLabel('Pessoal'));
    expect(pack).toContain(maskAccountLabel('Work'));
  });
});
