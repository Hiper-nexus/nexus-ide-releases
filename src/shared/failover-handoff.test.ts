/**
 * F-999: o pacote de continuidade é seguro POR CONSTRUÇÃO — todo texto citado
 * (motivo, tarefa, arquivos, diff, próximo passo, cauda do terminal) sai do
 * builder com segredos redigidos e sinais de limite neutralizados, seja qual
 * for o chamador (Main ou renderer). Segredos aqui são sintéticos.
 */
import { describe, expect, it } from 'vitest';
import {
  FAILOVER_HANDOFF_HEADER,
  buildContinuityPack,
  buildCrossAccountResumeNote,
  type ContinuityPackInput,
} from './failover-handoff';
import { detectLimit } from '../main/orch/limit-detector';
import { FailoverTextReducer, type FailoverTextProposal } from '../main/orch/failover-text-core';
import {
  SECRETS,
  dotenvDump,
  expectNoSecretFragment,
  hardWrap,
  inkWrap,
} from './__tests__/synthetic-secrets';

const BASE: ContinuityPackInput = {
  fromAccountLabel: 'conta.um@example.com',
  toAccountLabel: 'conta.dois@example.org',
  reason: 'quota',
  role: 'worker',
  missionId: 'mission-999',
  taskBrief: 'Corrigir o login',
  touchedFiles: ['src/login.ts'],
  diffStat: 'src/login.ts | 4 ++--',
  nextStep: 'Continue from the first pending step.',
};

/** Motivos reais que o detector reconhece — a 2ª linha do pack os cita. */
const LIVE_REASONS = [
  'model_not_found',
  'Error: model_not_found',
  'model_not_supported',
  'insufficient_quota',
  'usage_limit_reached',
  'overloaded_error',
  "The model 'gpt-x' does not exist or you do not have access to it",
  'not_found_error: model: claude-x',
  "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it",
  'models/gemini-9-pro is not found',
  'RESOURCE_EXHAUSTED',
  'Upstream request failed: Model access is disabled',
];

/** Toda janela de 4.000 chars que começa DEPOIS do header (TUI redesenhou sem ele). */
function expectEveryWindowInert(echo: string, label: string): void {
  const headerEnd = echo.indexOf(FAILOVER_HANDOFF_HEADER) + 1;
  for (let start = headerEnd; start < echo.length; start += 1) {
    const window = echo.slice(start, start + 4_000);
    const hit = detectLimit(window);
    if (hit) throw new Error(`${label}: janela em ${start} disparou ${hit.kind} (${hit.reason})`);
  }
}

describe('F-999 achado 2: o motivo na 2ª linha nunca vira sinal vivo', () => {
  it('cada motivo real, ecoado pela TUI a 80 colunas, fica inerte em toda janela deslocada', () => {
    for (const reason of LIVE_REASONS) {
      expect(detectLimit(reason), reason).not.toBeNull();
      const pack = buildContinuityPack({ ...BASE, reason, limitKind: 'model' });
      for (const echo of [pack, inkWrap(pack, 80), hardWrap(pack, 80)]) {
        expectEveryWindowInert(echo, reason);
      }
    }
  }, 120_000);

  it('o reducer real do failover não propõe nada com o eco do pack em pedaços variados', () => {
    const pack = buildContinuityPack({ ...BASE, reason: 'model_not_found', limitKind: 'model' });
    const echo = inkWrap(pack, 80).replace(FAILOVER_HANDOFF_HEADER, '');
    for (const size of [5, 37, 80, 333, echo.length]) {
      const reducer = new FailoverTextReducer();
      const proposals: FailoverTextProposal[] = [];
      let at = 0;
      for (let offset = 0; offset < echo.length; offset += size) {
        at += 300;
        proposals.push(...reducer.feed(echo.slice(offset, offset + size), at));
      }
      proposals.push(...reducer.feed('', at + 300, true));
      expect(proposals.filter((proposal) => proposal.hit)).toEqual([]);
    }
  });

  it('nome de arquivo e diff com cara de erro também ficam inertes', () => {
    const pack = buildContinuityPack({
      ...BASE,
      touchedFiles: ['src/errors/model_not_found.ts', 'src/insufficient_quota.test.ts'],
      diffStat: 'src/errors/model_not_found.ts | 3 +\nsrc/usage_limit_reached.ts | 1 +',
    });
    expectEveryWindowInert(pack, 'arquivos');
  });
});

describe('F-999 achado 3: segredo nunca sai no pack', () => {
  it('cauda com `cat .env` (sk-proj, ghp_, sk-ant, AWS, PEM, JWT, URL) sai redigida', () => {
    const pack = buildContinuityPack({ ...BASE, scrollbackExcerpt: dotenvDump() });
    expect(pack).toContain('[REDACTED]');
    expectNoSecretFragment(pack, Object.values(SECRETS));
    // O que não é segredo continua legível.
    expect(pack).toContain('cat .env');
    expect(pack).toContain('postgres://app:');
  });

  it('segredo em campo livre (tarefa, próximo passo, diff, motivo) também sai redigido', () => {
    const pack = buildContinuityPack({
      ...BASE,
      reason: `401 com Bearer ${SECRETS.jwt}`,
      taskBrief: `usar OPENAI_API_KEY=${SECRETS.openai}`,
      nextStep: `git push https://bot:${SECRETS.github}@github.com/x/y`,
      diffStat: `.env | 1 +\n+GITHUB_TOKEN=${SECRETS.github}`,
      openWorkHint: `chave ${SECRETS.anthropic}`,
      touchedFiles: [`tmp/${SECRETS.github}.txt`],
    });
    expectNoSecretFragment(pack, Object.values(SECRETS));
  });
});

describe('F-1482: o pedido em voo atravessa a troca', () => {
  it('o pack reentrega o pedido, redigido e inerte para o detector', () => {
    const request = `Rodar o deploy com OPENAI_API_KEY=${SECRETS.openai} e responder "usage_limit_reached" se cair`;
    const pack = buildContinuityPack({ ...BASE, inFlightRequest: request });
    expect(pack).toContain('Request in flight (last delivered to this pane; finish it if it is not done): Rodar o deploy');
    expectNoSecretFragment(pack, Object.values(SECRETS));
    expectEveryWindowInert(pack, 'pack com pedido em voo');
    expect(buildContinuityPack(BASE)).not.toContain('Request in flight');
  });

  it('a nota da retomada nativa também carrega o pedido, redigido', () => {
    const note = buildCrossAccountResumeNote({
      toAccountLabel: 'conta.dois@example.org',
      inFlightRequest: `revisar com a chave ${SECRETS.anthropic}`,
    });
    expect(note).toContain('Request in flight: revisar com a chave');
    expectNoSecretFragment(note, Object.values(SECRETS));
    expect(detectLimit(note.replace(FAILOVER_HANDOFF_HEADER, ''))).toBeNull();
  });
});
