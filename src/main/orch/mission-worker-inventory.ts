// F-1396: os workers Nexus vivos de uma missão, para o aviso do atalho de
// subagente. Fonte única do par de inventários Main-owned (PTY + ACP) que a
// colagem e o fast lane já usam — o aviso nunca conta "subagentes" do Claude
// Code, que não são panes e não aparecem aqui.
//
// Import lazy de propósito: o endpoint de hook é carregado em contextos de
// teste e de CLI onde o pty-manager traz Electron. Falha de carga vira lista
// vazia (fail-closed no sentido do hook: sem contagem, sem nudge) — nunca lança.

import type { OwnedAgentSessionInfo } from '../pty/pty-manager';

export type MissionWorkerLister = (missionId: string) => OwnedAgentSessionInfo[];

let cachedLister: Promise<MissionWorkerLister> | null = null;

/** Workers (não o Maestro) de uma missão, do inventário vivo do Main. */
async function buildLister(): Promise<MissionWorkerLister> {
  const [{ listAgentSessions }, { listAcpDriverAgentSessions }] = await Promise.all([
    import('../pty/pty-manager'),
    import('../acp/acp-harness-driver'),
  ]);
  return (missionId) =>
    [...listAgentSessions(), ...listAcpDriverAgentSessions()].filter(
      (session) => session.missionId === missionId && session.role === 'worker',
    );
}

/**
 * Quantos workers Nexus a missão tem vivos agora. O papel `worker` é o filtro:
 * o pane do próprio Maestro não conta como worker dele. Erro de carga/import
 * devolve 0 — quem chama decide o que um zero significa; aqui só não joga.
 */
export async function countMissionWorkers(missionId: string): Promise<number> {
  try {
    cachedLister ??= buildLister();
    return (await cachedLister)(missionId).length;
  } catch {
    cachedLister = null;
    return 0;
  }
}

/** Test-only: solta a lista memorizada. */
export function __resetMissionWorkerInventoryForTests(): void {
  cachedLister = null;
}