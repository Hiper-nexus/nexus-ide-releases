import { describe, expect, it } from 'vitest';
import {
  buildPaneSpawnLifecycleEvent,
  buildPaneSpawnRecoveryEvent,
  classifySpawnErrorCode,
  classifySpawnInjectionOrigin,
} from './pane-spawn-lifecycle';

describe('buildPaneSpawnLifecycleEvent (F-787)', () => {
  it('rota AUTO registra adapter e modelo EFETIVOS, não o pedido', () => {
    // Campo 03/10: 48,5% dos spawns aceitos eram AUTO (sem adapterId nos
    // argumentos) e o evento não gravava o modelo efetivo — a saúde da
    // inferência não era reconstruível.
    const event = buildPaneSpawnLifecycleEvent({
      meta: {
        adapterId: 'codex',
        model: 'gpt-6.1-sol',
        paneId: 'pane-1',
        sessionId: 'pty-1',
        ok: true,
      },
      caller: { role: 'orchestrator', missionId: 'm1', sessionId: 'pty-maestro' },
      requestedAdapterId: null,
      requestedMissionId: null,
      totalMs: 1_200,
      phases: {},
    });
    expect(event.adapterId).toBe('codex');
    expect(event.model).toBe('gpt-6.1-sol');
    expect(event.sessionId).toBe('pty-1');
    expect(event.callerSessionId).toBe('pty-maestro');
    expect(event.paneCreated).toBe(true);
    expect(event.origin).toBe('maestro');
  });

  it('rejeição antes do primeiro turno é distinguível de pane criado', () => {
    const rejected = buildPaneSpawnLifecycleEvent({
      meta: { ok: false, errorCode: 'authority_seal_unavailable' },
      caller: { role: 'user', sessionId: 'pty-op' },
      requestedAdapterId: 'codex',
      totalMs: 40,
      phases: {},
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.paneCreated).toBe(false);
    expect(rejected.paneId).toBeNull();
    expect(rejected.errorCode).toBe('authority_seal_unavailable');

    const created = buildPaneSpawnLifecycleEvent({
      meta: { adapterId: 'kimi', paneId: 'pane-9', sessionId: 'pty-9', ok: true },
      caller: { role: 'user', sessionId: 'pty-op' },
      totalMs: 900,
      phases: {},
    });
    expect(created.ok).toBe(true);
    expect(created.paneCreated).toBe(true);
    expect(created.origin).toBe('operador');
    expect(created.errorCode).toBeUndefined();
  });

  it('reuso de helper é marcado como reuso, nunca como rejeição', () => {
    const event = buildPaneSpawnLifecycleEvent({
      meta: { adapterId: 'kimi', paneId: 'pane-3', sessionId: 'pty-3', ok: true, reused: true },
      caller: { role: 'user', sessionId: 'pty-op' },
      totalMs: 120,
      phases: {},
    });
    expect(event.reused).toBe(true);
    expect(event.ok).toBe(true);
    expect(event.paneCreated).toBe(true);
  });

  it('não leva prompt, argv, ambiente, conta, fingerprint nem token', () => {
    const event = buildPaneSpawnLifecycleEvent({
      meta: { adapterId: 'codex', model: 'gpt-6.1-sol', paneId: 'pane-1', ok: true },
      caller: { role: 'user', sessionId: 'pty-op' },
      totalMs: 1,
      phases: {},
    });
    for (const banned of [
      'prompt', 'argv', 'env', 'account', 'token', 'fingerprint', 'brief', 'task',
    ]) {
      expect(Object.keys(event)).not.toContain(banned);
    }
  });
});

describe('classifySpawnInjectionOrigin', () => {
  it('classifica sistema/Maestro/operador sem conteúdo', () => {
    expect(classifySpawnInjectionOrigin({ role: 'user', missionId: null })).toBe('operador');
    expect(classifySpawnInjectionOrigin({ role: 'user', missionId: 'm1' })).toBe('maestro');
    expect(classifySpawnInjectionOrigin({ role: 'orchestrator', missionId: 'm1' })).toBe('maestro');
  });
});

describe('classifySpawnErrorCode', () => {
  it.each([
    ['handoff_origin: current approved mission unavailable', 'handoff_origin'],
    ['session_authority_revoked', 'session_authority_revoked'],
    ['claude_accounts_in_use', 'claude_accounts_in_use'],
    ['not authorized: workers cannot create panes — only the orchestrator may spawn', 'not_authorized'],
    ['authority seal indisponível no momento', 'authority_seal_unavailable'],
    ['o renderer não está pronto para receber o pane', 'renderer_unavailable'],
    ['existe um writer ainda ativo neste checkout', 'writer_active'],
    ['algo completamente inesperado aconteceu', 'spawn_failed'],
  ])('%s → %s', (message, code) => {
    expect(classifySpawnErrorCode(new Error(message))).toBe(code);
  });

  it('nunca devolve o texto bruto do erro', () => {
    const code = classifySpawnErrorCode(new Error('falhou com segredo sk-123 no meio'));
    expect(code).not.toContain('sk-123');
    expect(code).not.toContain('segredo');
  });
});

describe('buildPaneSpawnRecoveryEvent (F-787)', () => {
  it('tentativa de recuperação do sistema com resultado', () => {
    const okEvent = buildPaneSpawnRecoveryEvent({
      callerSessionId: 'pty-maestro',
      excludeAdapterIds: ['codex'],
      paneId: 'pane-2',
      adapterId: 'kimi',
      ok: true,
    });
    expect(okEvent).toMatchObject({
      kind: 'pane-spawn-recovery',
      origin: 'sistema',
      ok: true,
      paneId: 'pane-2',
      adapterId: 'kimi',
      callerSessionId: 'pty-maestro',
    });
    expect(okEvent.excludeAdapterIds).toEqual(['codex']);

    const failEvent = buildPaneSpawnRecoveryEvent({
      callerSessionId: 'pty-maestro',
      excludeAdapterIds: ['codex'],
      ok: false,
      errorCode: 'pty_spawn_failed',
    });
    expect(failEvent).toMatchObject({
      ok: false,
      errorCode: 'pty_spawn_failed',
      paneId: null,
    });
  });
});
