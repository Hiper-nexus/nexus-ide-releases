/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionPaneRecoveryRequest } from '../../shared/orch-types';
import {
  installMissionPaneRecoveryReasonListener,
  missionPaneRecoveryNotice,
  rememberMissionPaneRecoveryReason,
  resetMissionPaneRecoveryReasonsForTests,
  takeMissionPaneRecoveryReason,
} from './mission-pane-recovery-notice';

afterEach(() => {
  resetMissionPaneRecoveryReasonsForTests();
  Reflect.deleteProperty(window, 'nexus');
});

describe('linha do pane quando o Main troca a sessão do Maestro (F-1581)', () => {
  it('troca de conta por limite diz o motivo, não "contexto degradado"', () => {
    const line = missionPaneRecoveryNotice('account-failover', false);
    expect(line).toContain('troca de conta por limite confirmado');
    expect(line).not.toContain('contexto degradado');
  });

  it('entrega recusada diz que o Maestro não aceitou a entrega', () => {
    expect(missionPaneRecoveryNotice('handoff-delivery', false)).toContain(
      'o Maestro não aceitou a entrega',
    );
  });

  it('sem motivo conhecido o texto é genérico e honesto', () => {
    const line = missionPaneRecoveryNotice(undefined, false);
    expect(line).toContain('recuperação automática');
    expect(line).not.toContain('contexto degradado');
  });

  it('retomada nativa entre contas mantém a linha da conversa retomada', () => {
    expect(missionPaneRecoveryNotice('account-failover', true)).toContain(
      'retomando a mesma conversa na conta nova',
    );
  });

  it('guarda o motivo do pedido do Main por requestId e entrega uma vez', () => {
    let listener: ((request: MissionPaneRecoveryRequest) => void) | null = null;
    const onPaneRecoveryRequest = vi.fn((cb: (request: MissionPaneRecoveryRequest) => void) => {
      listener = cb;
      return () => undefined;
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: { onPaneRecoveryRequest } },
    });
    installMissionPaneRecoveryReasonListener();
    installMissionPaneRecoveryReasonListener();
    expect(onPaneRecoveryRequest).toHaveBeenCalledTimes(1);

    listener!({ requestId: 'panerecovery-1', reason: 'handoff-delivery' } as MissionPaneRecoveryRequest);
    expect(takeMissionPaneRecoveryReason('panerecovery-1')).toBe('handoff-delivery');
    expect(takeMissionPaneRecoveryReason('panerecovery-1')).toBeUndefined();
  });

  it('ignora motivo fora da lista fechada e pedido sem requestId', () => {
    rememberMissionPaneRecoveryReason({ requestId: 'r1', reason: 'qualquer' as never });
    rememberMissionPaneRecoveryReason({ requestId: '', reason: 'account-failover' });
    expect(takeMissionPaneRecoveryReason('r1')).toBeUndefined();
    expect(takeMissionPaneRecoveryReason(undefined)).toBeUndefined();
  });

  it('não cresce sem fim: só os pedidos mais recentes ficam guardados', () => {
    for (let index = 0; index < 40; index += 1) {
      rememberMissionPaneRecoveryReason({ requestId: `r${index}`, reason: 'account-failover' });
    }
    expect(takeMissionPaneRecoveryReason('r0')).toBeUndefined();
    expect(takeMissionPaneRecoveryReason('r39')).toBe('account-failover');
  });
});
