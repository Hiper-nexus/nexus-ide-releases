import { describe, expect, it, vi } from 'vitest';

vi.mock('./worker-delivery-board', () => ({
  recordWorkerDeliveryIfDelivered: vi.fn(),
  markSessionSealedBoardCredited: vi.fn(),
}));

import {
  __noteTurnStartForTests,
  __resetTurnEndHandoffForTests,
  attachToExistingHandoff,
  buildMechanicalHandoffPayload,
  condenseFullText,
  countRecentWorkerHandoffs,
  decideTurnEndClosure,
  getHandoffAttachments,
  harvestTurnReplyText,
  MECHANICAL_HANDOFF_CLOSED_BY,
  MECHANICAL_HANDOFF_FULLTEXT_CAP,
  MECHANICAL_HANDOFF_MARK,
  MECHANICAL_HANDOFF_VERBATIM_LIMIT,
  payloadReplyText,
  readLastAssistantTextFromTranscript,
} from './turn-end-handoff';
import type { Handoff } from '../../shared/orch-types';

const baseFacts = {
  hasGateContext: true,
  isMissionWorker: true,
  lastInputFromHuman: false,
  replyText: 'Feito: testes verdes e commit criado.',
  handoffsSinceTurnStart: 0,
  isRedeliveryOfProcessedStop: false,
  dedupUnavailable: false,
};

describe('decideTurnEndClosure (matriz de guardas)', () => {
  it('fecha quando o worker de missão encerra sem entregar', () => {
    const decision = decideTurnEndClosure(baseFacts);
    expect(decision.close).toBe(true);
  });

  it('pula sessão sem gate ctx (pane não agenciado)', () => {
    const decision = decideTurnEndClosure({ ...baseFacts, hasGateContext: false });
    expect(decision.close).toBe(false);
    expect(decision.reason).toContain('gate ctx');
  });

  it('pula orquestrador e pane do usuário (anti-eco colapsa no role)', () => {
    const decision = decideTurnEndClosure({ ...baseFacts, isMissionWorker: false });
    expect(decision.close).toBe(false);
    expect(decision.reason).toContain('worker de missão');
  });

  it('pula turno aberto pelo teclado do operador (F-339)', () => {
    const decision = decideTurnEndClosure({ ...baseFacts, lastInputFromHuman: true });
    expect(decision.close).toBe(false);
    expect(decision.reason).toContain('operador');
  });

  it('pula quando não há texto honesto — nunca inventa resposta', () => {
    const decision = decideTurnEndClosure({ ...baseFacts, replyText: '   ' });
    expect(decision.close).toBe(false);
    expect(decision.reason).toContain('texto honesto');
  });

  it('pula quando o worker já entregou handoff neste turno (dedup C-194.1)', () => {
    const decision = decideTurnEndClosure({
      ...baseFacts,
      handoffsSinceTurnStart: 1,
    });
    expect(decision.close).toBe(false);
    expect(decision.reason).toContain('já entregou');
  });

  it('pula re-disparo do mesmo Stop (idle 2x do opencode, Stop extra do grok)', () => {
    const decision = decideTurnEndClosure({
      ...baseFacts,
      isRedeliveryOfProcessedStop: true,
    });
    expect(decision.close).toBe(false);
    expect(decision.reason).toContain('re-disparo');
  });

  it('pula quando o dedup está indisponível — fail-closed, nunca duplica na dúvida', () => {
    const decision = decideTurnEndClosure({
      ...baseFacts,
      dedupUnavailable: true,
    });
    expect(decision.close).toBe(false);
    expect(decision.reason).toContain('dedup indisponível');
  });

  it('fecha mesmo com delegação recente — espera do Maestro NÃO veta o fechamento (F-104)', () => {
    // Campo 21/08: o veto "aguarda handoff" lacrava workers que nunca chamam
    // nexus_handoff_submit — o marcador só era limpo pelo próprio submit.
    // O fechamento mecânico É a resolução da espera; dedup fica por conta da
    // janela do turno e da impressão digital do Stop.
    const decision = decideTurnEndClosure(baseFacts);
    expect(decision.close).toBe(true);
    expect(decision.reason).toContain('fechamento mecânico');
  });
});

describe('countRecentWorkerHandoffs (dedup por encarnação física)', () => {
  const mk = (over: Partial<Handoff>): Handoff =>
    ({
      id: 'h1',
      missionId: 'm1',
      status: 'success',
      summary: 's',
      artifacts: [],
      evidenceIds: [],
      evidenceTrust: 'none',
      delivered: false,
      deliveryState: 'queued',
      createdAt: 1_000,
      ...over,
    }) as Handoff;

  it('conta handoff da mesma sessão dentro da janela do turno', () => {
    const n = countRecentWorkerHandoffs(
      [mk({ sessionId: 's1', createdAt: 1_500 })],
      { sessionId: 's1', windowStart: 1_000 },
    );
    expect(n).toBe(1);
  });

  it('conta handoff de OUTRA sessão da MESMA encarnação (rebind/respawn no meio do turno)', () => {
    const n = countRecentWorkerHandoffs(
      [mk({ sessionId: 's-antiga', workerIncarnationId: 'inc-1', createdAt: 1_500 })],
      { sessionId: 's-nova', workerIncarnationId: 'inc-1', windowStart: 1_000 },
    );
    expect(n).toBe(1);
  });

  it('ignora handoff de encarnação e sessão diferentes', () => {
    const n = countRecentWorkerHandoffs(
      [mk({ sessionId: 's-outro', workerIncarnationId: 'inc-2', createdAt: 1_500 })],
      { sessionId: 's1', workerIncarnationId: 'inc-1', windowStart: 1_000 },
    );
    expect(n).toBe(0);
  });

  it('janela 0 (primeiro turno de sessão física nova) conta handoffs anteriores da encarnação', () => {
    const n = countRecentWorkerHandoffs(
      [mk({ sessionId: 's-antiga', workerIncarnationId: 'inc-1', createdAt: 500 })],
      { sessionId: 's-nova', workerIncarnationId: 'inc-1', windowStart: 0 },
    );
    expect(n).toBe(1);
  });

  it('ignora handoff criado antes da fronteira do turno', () => {
    const n = countRecentWorkerHandoffs(
      [mk({ sessionId: 's1', createdAt: 900 })],
      { sessionId: 's1', windowStart: 1_000 },
    );
    expect(n).toBe(0);
  });

  it.each(['nexus-watchdog', 'nexus-handoff-enforcement'])('não deduplica diagnóstico provisório de %s', (fromAgent) => {
    expect(countRecentWorkerHandoffs(
      [mk({ sessionId: 's1', fromAgent, status: 'blocked' })],
      { sessionId: 's1', windowStart: 0 },
    )).toBe(0);
  });

  it('mantém dedup para diagnóstico que possui receipt físico ou confirmação humana', () => {
    expect(countRecentWorkerHandoffs(
      [
        mk({ sessionId: 's1', fromAgent: 'nexus-watchdog', status: 'failed', mcpProvenance: {} as Handoff['mcpProvenance'] }),
        mk({ sessionId: 's1', fromAgent: 'nexus-handoff-enforcement', status: 'blocked', authorityOrigin: 'operator-confirmed' }),
      ],
      { sessionId: 's1', windowStart: 0 },
    )).toBe(2);
  });
});

describe('buildMechanicalHandoffPayload (regra 1.2.3)', () => {
  it('resposta curta viaja INTEIRA no summary, e fullText é preservado', () => {
    const short = 'Ok, deploy concluído sem erros.';
    const payload = buildMechanicalHandoffPayload({ replyText: short });
    expect(payload.status).toBe('success');
    expect(payload.summary).toBe(`${MECHANICAL_HANDOFF_MARK} ${short}`);
    const artifact = payload.artifacts[0] as Record<string, unknown>;
    expect(artifact.auto).toBe(true);
    expect(artifact.closedBy).toBe(MECHANICAL_HANDOFF_CLOSED_BY);
    expect(artifact.fullText).toBe(short);
  });

  it('summary curto demais recebe o enxerto honesto (mínimo de 20 do store)', () => {
    const payload = buildMechanicalHandoffPayload({ replyText: 'Ok.' });
    expect(payload.summary.length).toBeGreaterThanOrEqual(20);
    expect(payload.summary).toContain('Ok.');
    expect(payload.summary.startsWith(MECHANICAL_HANDOFF_MARK)).toBe(true);
  });

  it('resposta longa viaja a VERDADE + ponteiro, íntegra em artifacts[0].fullText', () => {
    const long = ('linha de resultado. ').repeat(80);
    const payload = buildMechanicalHandoffPayload({ replyText: long });
    expect(payload.summary).toContain('resposta longa');
    expect(payload.summary).toContain(String(long.replace(/\s+/g, ' ').trim().length));
    expect(payload.summary).not.toContain(long.slice(0, 100));
    expect(payload.summary.length).toBeLessThanOrEqual(MECHANICAL_HANDOFF_VERBATIM_LIMIT);
    const artifact = payload.artifacts[0] as Record<string, unknown>;
    expect(artifact.fullText).toBe(long);
  });

  it('resposta gigante (>60k) aplica condense mecânico determinístico head 20k + tail 20k', () => {
    const huge = 'A'.repeat(30_000) + 'B'.repeat(40_000);
    const payload = buildMechanicalHandoffPayload({ replyText: huge });
    const artifact = payload.artifacts[0] as Record<string, unknown>;
    const fullText = artifact.fullText as string;
    expect(fullText.length).toBeLessThanOrEqual(MECHANICAL_HANDOFF_FULLTEXT_CAP);
    expect(fullText).toContain('30000 caracteres omitidos');
    expect(fullText.startsWith('A'.repeat(20_000))).toBe(true);
    expect(fullText.endsWith('B'.repeat(20_000))).toBe(true);
  });

  it('carrega sessionId e transcript nos artifacts quando existem', () => {
    const payload = buildMechanicalHandoffPayload({
      replyText: 'resposta suficiente para o mínimo do store.',
      sessionId: 'pty-9',
      transcriptPath: '/tmp/t.jsonl',
    });
    const artifact = payload.artifacts[0] as Record<string, unknown>;
    expect(artifact.sessionId).toBe('pty-9');
    expect(artifact.transcript).toBe('/tmp/t.jsonl');
  });

  it('F-786: admissão de tarefa sem prova não nasce success — partial com texto integral', () => {
    // Campo 03/10: o fechamento mecânico fixava success; "não consegui abrir
    // nem inspecionar o preview" virava entrega bem-sucedida sem evidência.
    const reply = 'não consegui abrir nem inspecionar o preview';
    const payload = buildMechanicalHandoffPayload({ replyText: reply });
    expect(payload.status).toBe('partial');
    const artifact = payload.artifacts[0] as Record<string, unknown>;
    expect(artifact.fullText).toBe(reply);
  });

  it('F-786: variações de admissão ("não foi possível") também nascem partial', () => {
    expect(
      buildMechanicalHandoffPayload({
        replyText: 'Não foi possível rodar a suíte de testes desta vez.',
      }).status,
    ).toBe('partial');
  });

  it('F-786: resposta sem admissão de incompletude continua success', () => {
    expect(
      buildMechanicalHandoffPayload({
        replyText: 'Preview inspecionado: layout quebrado no mobile; relatório acima.',
      }).status,
    ).toBe('success');
  });
});

describe('payloadReplyText (F-355 — payload antes do transcript)', () => {
  it('lê last_assistant_message do payload do Claude', () => {
    expect(
      payloadReplyText({ last_assistant_message: ' resposta do turno ' }),
    ).toBe('resposta do turno');
  });

  it('lê prompt_response dos outros sabores', () => {
    expect(payloadReplyText({ prompt_response: 'r' })).toBe('r');
    expect(payloadReplyText({ promptResponse: 'r2' })).toBe('r2');
  });

  it('payload sem texto devolve vazio', () => {
    expect(payloadReplyText({})).toBe('');
    expect(payloadReplyText({ last_assistant_message: 42 })).toBe('');
  });

  it('lê o dialeto do codex-rs (last_agent_message) e o notify com hífen', () => {
    expect(payloadReplyText({ last_agent_message: '2' })).toBe('2');
    expect(payloadReplyText({ 'last-assistant-message': ' 2 ' })).toBe('2');
    expect(payloadReplyText({ lastAgentMessage: 'ok' })).toBe('ok');
  });

  it('acha o texto aninhado no envelope do evento', () => {
    expect(
      payloadReplyText({
        type: 'agent-turn-complete',
        payload: { 'last-assistant-message': '1+1 = 2' },
      }),
    ).toBe('1+1 = 2');
  });

  it('ignora campo vazio e não confunde chave desconhecida com resposta', () => {
    expect(payloadReplyText({ last_agent_message: '   ' })).toBe('');
    expect(payloadReplyText({ session_id: 'pty-1', cwd: '/tmp' })).toBe('');
  });
});

describe('readLastAssistantTextFromTranscript (varredura tolerante)', () => {
  const claudeShape = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'faça X' } }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'resultado Y' }] },
    }),
  ].join('\n');

  const toolResultBoundary = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'tarefa' } }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'resposta antiga' }] },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'resposta final curta' },
    }),
  ].join('\n');

  const genericShape = [
    JSON.stringify({ role: 'user', content: 'pergunta' }),
    JSON.stringify({ role: 'assistant', content: 'via shape genérico' }),
  ].join('\n');

  it('extrai a última fala do shape do Claude', () => {
    expect(readLastAssistantTextFromTranscript('/t', () => claudeShape)).toBe('resultado Y');
  });

  it('tool_result não é fronteira de humano — a varredura segue', () => {
    expect(readLastAssistantTextFromTranscript('/t', () => toolResultBoundary)).toBe(
      'resposta final curta',
    );
  });

  it('cobre shapes genéricos por role (codex/grok)', () => {
    expect(readLastAssistantTextFromTranscript('/t', () => genericShape)).toBe(
      'via shape genérico',
    );
  });

  it('arquivo ilegível ou sem fala devolve vazio', () => {
    expect(readLastAssistantTextFromTranscript('/t', () => {
      throw new Error('ENOENT');
    })).toBe('');
    expect(
      readLastAssistantTextFromTranscript('/t', () =>
        [JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } })].join('\n'),
      ),
    ).toBe('');
  });
});

describe('harvestTurnReplyText', () => {
  it('payload vence — sem tocar em disco', async () => {
    const text = await harvestTurnReplyText(
      { last_assistant_message: 'direto do payload' },
      async () => {
        throw new Error('não deveria esperar');
      },
    );
    expect(text).toBe('direto do payload');
  });

  it('sem payload e sem transcript_path devolve vazio imediatamente', async () => {
    const text = await harvestTurnReplyText({}, async () => {
      throw new Error('não deveria esperar');
    });
    expect(text).toBe('');
  });
});

describe('estado de turno', () => {
  it('__noteTurnStartForTests registra fronteira (uso interno do dedup)', () => {
    __resetTurnEndHandoffForTests();
    __noteTurnStartForTests({ sessionId: 's1', paneId: 'p1', sequence: 3, observedAt: 1_000 });
    expect(() =>
      __noteTurnStartForTests({ sessionId: 's1', paneId: 'p1', sequence: 4, observedAt: 2_000 }),
    ).not.toThrow();
    __resetTurnEndHandoffForTests();
  });
});

describe('constantes da régua', () => {
  it('mantém a régua do Overclock', () => {
    expect(MECHANICAL_HANDOFF_VERBATIM_LIMIT).toBe(280);
    expect(MECHANICAL_HANDOFF_FULLTEXT_CAP).toBe(60_000);
    expect(MECHANICAL_HANDOFF_MARK).toBe('[auto]');
  });
});

describe('condenseFullText (T3)', () => {
  it('preserva texto menor ou igual ao cap', () => {
    const text = 'Texto pequeno para o teste.';
    expect(condenseFullText(text)).toBe(text);
  });

  it('aplica condense determinístico em textos maiores que 60k', () => {
    const head = 'H'.repeat(20_000);
    const middle = 'M'.repeat(30_000);
    const tail = 'T'.repeat(20_000);
    const text = head + middle + tail;
    const condensed = condenseFullText(text);

    expect(condensed.length).toBeLessThan(70_000);
    expect(condensed).toContain('30000 caracteres omitidos');
    expect(condensed.startsWith(head)).toBe(true);
    expect(condensed.endsWith(tail)).toBe(true);
  });
});

describe('modo attach (T3)', () => {
  it('anexa artefato a handoff existente em envio duplo sem criar card duplicado', () => {
    __resetTurnEndHandoffForTests();
    const handoffId = 'handoff-turn-1';
    attachToExistingHandoff(handoffId, {
      auto: true,
      closedBy: 'turn-end-attach',
      attachedAt: Date.now(),
      fullText: 'Segundo envio do mesmo turno.',
    });

    const attachments = getHandoffAttachments(handoffId);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      auto: true,
      closedBy: 'turn-end-attach',
      fullText: 'Segundo envio do mesmo turno.',
    });
  });
});
