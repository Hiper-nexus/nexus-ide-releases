import { describe, expect, it } from 'vitest';
import {
  buildContinuityPack,
  buildSameAccountContinuePrompt,
} from './failover-continuity';
import { detectLimit } from '../../main/orch/limit-detector';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';

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
    expect(pack).toContain('Work');
    expect(pack).toContain('Personal');
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
});
