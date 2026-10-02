import { describe, expect, it } from 'vitest';
import {
  EXACT_RESUME_FAST_EXIT_MS,
  EXACT_RESUME_STRIKES_TO_FORGET,
  createExactResumeHealth,
  type ExactResumeAttempt,
} from './exact-resume-health';

const attempt: ExactResumeAttempt = {
  scope: { installationId: 'i', projectId: 'p', checkoutId: 'c' },
  adapterId: 'claude',
  sessionId: 'b3df56cb-0000-4000-8000-000000000001',
};
const fail = { exitCode: 1, uptimeMs: 800, deliberate: false } as const;

describe('exact-resume-health (F-721: id de retomada que nunca virou transcrito)', () => {
  it('a primeira saída rápida com erro é só um aviso; a segunda do MESMO id manda esquecer o vínculo', () => {
    const health = createExactResumeHealth();
    expect(health.judge(attempt, fail)).toBe('strike');
    expect(health.judge(attempt, fail)).toBe('forget');
    expect(EXACT_RESUME_STRIKES_TO_FORGET).toBe(2);
  });

  it('o golpe é do ID da conversa, não do pane: cada "Retomar" abre um pane novo e o id velho continua o mesmo', () => {
    // O Maestro religado nasce com paneId novo a cada tentativa; a chave NÃO pode incluir o pane.
    const health = createExactResumeHealth();
    expect(health.judge(attempt, fail)).toBe('strike');
    expect(health.judge({ ...attempt }, fail)).toBe('forget');
  });

  it('depois de esquecer, a contagem recomeça (um id novo capturado depois começa do zero)', () => {
    const health = createExactResumeHealth();
    health.judge(attempt, fail);
    health.judge(attempt, fail);
    expect(health.judge(attempt, fail)).toBe('strike');
  });

  it('só o código 1 (erro da própria CLI) conta: falha de ambiente não apaga vínculo nenhum', () => {
    const health = createExactResumeHealth();
    // 76 = gate do macOS 27, 126/127 = binário ausente/sem permissão, 137/143 = morto, 0 = limpo.
    for (const exitCode of [76, 126, 127, 137, 143, 2]) {
      expect(health.judge(attempt, { ...fail, exitCode })).toBe('ignored');
    }
    expect(health.judge(attempt, fail)).toBe('strike');
  });

  it('um boot que sobrevive prova o id e zera os golpes — mesmo que depois o Nexus o encerre de propósito', () => {
    const health = createExactResumeHealth();
    health.judge(attempt, fail);
    expect(health.judge(attempt, { exitCode: 143, uptimeMs: EXACT_RESUME_FAST_EXIT_MS + 1, deliberate: true })).toBe('ok');
    expect(health.judge(attempt, fail)).toBe('strike');
    expect(health.judge(attempt, { exitCode: 0, uptimeMs: 100, deliberate: false })).toBe('ok');
    expect(health.judge(attempt, fail)).toBe('strike');
  });

  it('morte rápida pedida pelo próprio Nexus não conta nem zera', () => {
    const health = createExactResumeHealth();
    health.judge(attempt, fail);
    expect(health.judge(attempt, { exitCode: 1, uptimeMs: 50, deliberate: true })).toBe('ignored');
    expect(health.judge(attempt, fail)).toBe('forget');
  });

  it('cada (projeto, CLI, id) tem a sua contagem', () => {
    const health = createExactResumeHealth();
    health.judge(attempt, fail);
    for (const other of [
      { ...attempt, sessionId: 'outro-id' },
      { ...attempt, adapterId: 'codex' },
      { ...attempt, scope: { ...attempt.scope, checkoutId: 'c2' } },
    ]) {
      expect(health.judge(other, fail)).toBe('strike');
    }
  });

  it('a memória é limitada: ids demais não crescem o mapa sem fim', () => {
    const health = createExactResumeHealth();
    for (let index = 0; index < 5_000; index += 1) {
      health.judge({ ...attempt, sessionId: `id-${index}` }, fail);
    }
    expect(health.size()).toBeLessThanOrEqual(1_024);
  });
});
