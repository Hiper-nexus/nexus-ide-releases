/**
 * Wiring do fluxo C3 (follow-up 3ii) no padrão source-shape do repo
 * (ver click-wake-order.test.ts): propriedades estruturais que uma
 * regressão de merge quebraria silenciosamente.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const finishSource = fs.readFileSync(
  path.join(__dirname, 'voice-finish-and-process.ts'),
  'utf-8',
);
const controllerSource = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf-8');
const executorSource = fs.readFileSync(
  path.join(__dirname, 'jarvis-action-executor.ts'),
  'utf-8',
);

describe('guard Live-force-to-Classic (C3)', () => {
  it('a primeira fala pós-"Confirmo?" NUNCA vai pro provider Live', () => {
    const guardIdx = finishSource.indexOf(
      'const isPendingDelegationReply = peekPendingDelegation(Date.now()) !== null;',
    );
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    const providerCondIdx = finishSource.indexOf('!isPendingDelegationReply &&');
    expect(providerCondIdx).toBeGreaterThan(guardIdx);
    // O guard entra ANTES da política de resposta do provider.
    expect(providerCondIdx).toBeLessThan(
      finishSource.indexOf('shouldLetRealtimeProviderAnswer(transcript'),
    );
  });
});

describe('pendência sobrevive ao re-wake (follow-up 4a)', () => {
  it('beginListening NÃO limpa mais a pendência de delegação', () => {
    const beginIdx = controllerSource.indexOf('async function beginListening');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(controllerSource.slice(beginIdx)).not.toContain('clearPendingDelegation');
  });
});

describe('re-wake com pendência viva confirma em vez de morrer no stripper (C3 Fase 1)', () => {
  const reaskSource = fs.readFileSync(
    path.join(__dirname, 'delegation-reask.ts'),
    'utf-8',
  );
  // O caminho classic começa no STT local; tudo antes é o caminho realtime.
  const classicStart = finishSource.indexOf(
    'const stt = cachedStt ?? (await transcribeCapture());',
  );
  const realtimeHalf = finishSource.slice(0, classicStart);
  const classicHalf = finishSource.slice(classicStart);

  it('o stripper recebe protectConfirmation nos DOIS caminhos (realtime e classic)', () => {
    expect(classicStart).toBeGreaterThan(0);
    expect(realtimeHalf).toContain('protectConfirmation');
    expect(classicHalf).toContain('protectConfirmation');
  });

  it('descarte vazio de wake/click com pendência re-pergunta nos DOIS caminhos', () => {
    expect(realtimeHalf).toContain('reaskPendingDelegation(');
    expect(classicHalf).toContain('reaskPendingDelegation(');
  });

  it('o re-ask NUNCA despacha: só fala, renova TTL e reabre escuta de reply', () => {
    expect(reaskSource).not.toContain('writeToPane');
    expect(reaskSource).toContain('refreshPendingDelegation(');
    expect(reaskSource).toContain('recordEcho(PENDING_REASK_PROMPT)');
    // Reabre como 'reply' — caminho SEM stripper de ack, onde "sim" seco já funciona.
    expect(reaskSource).toContain("'reply'");
  });
});

describe('tool nativa do Live consome a pendência (review final, item 3)', () => {
  it('descarta apenas a pendência que já existia, preservando a criada pela tool atual', () => {
    const helperIdx = finishSource.indexOf('const finishRealtimeToolTurn = ()');
    const waitIdx = finishSource.indexOf('realtimeTranscriptWaiter.wait(');
    const branchIdx = finishSource.indexOf(
      "turnExecution.isOwnedBy('realtime-tool', turnToken)",
      waitIdx,
    );
    expect(helperIdx).toBeGreaterThanOrEqual(0);
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(finishSource.slice(branchIdx, branchIdx + 220)).toContain(
      'hasRealtimeNativeToolSince(tRealtime)',
    );
    const clearIdx = finishSource.indexOf('clearPendingDelegation()', helperIdx);
    const dropLogIdx = finishSource.indexOf("'jarvis.delegationDropped'", helperIdx);
    const releaseIdx = finishSource.indexOf('releaseAfterRealtimeTool();', helperIdx);
    expect(clearIdx).toBeGreaterThan(helperIdx);
    expect(dropLogIdx).toBeGreaterThan(helperIdx);
    expect(finishSource.slice(helperIdx, clearIdx)).toContain(
      'shouldDiscardPendingDelegationAfterUnrelatedTool',
    );
    // Descarte (clear + log) acontece antes do release que encerra o turno.
    expect(releaseIdx).toBeGreaterThan(clearIdx);
    expect(releaseIdx).toBeGreaterThan(dropLogIdx);
    const toolBranch = finishSource.slice(branchIdx, finishSource.indexOf('if (liveTranscript)', branchIdx));
    // Ferramentas podem narrar áudio depois do resultado; a reabertura passa
    // pelo helper único que espera o completion correlacionado.
    expect(toolBranch).toContain('finishRealtimeToolTurn();');
  });
});

describe('delegação rotineira segue direto para o orquestrador', () => {
  it('não cria uma segunda rodada de confirmação por voz', () => {
    expect(executorSource).not.toContain('setPendingDelegation({');
    expect(executorSource).not.toContain('jarvis.delegationAuthorityArmed');
    expect(executorSource).not.toContain('delegationConfirmPrompt(action.text)');
    expect(executorSource).toContain('pane.delegationSubmitted');
  });

  it('prepara briefing executável só para missão nova, preservando respostas roteadas', () => {
    const directReplyIdx = executorSource.indexOf("if (target.kind === 'asking-pane')");
    const delegationIdx = executorSource.indexOf('const missionPrompt = prepareDelegationPrompt');

    expect(directReplyIdx).toBeGreaterThanOrEqual(0);
    expect(delegationIdx).toBeGreaterThan(directReplyIdx);
    expect(executorSource.slice(directReplyIdx, delegationIdx)).toContain(
      '`${action.text}\\n`',
    );
    expect(executorSource.slice(delegationIdx, delegationIdx + 400)).toContain(
      '`${missionPrompt}\\n`',
    );
  });
});

describe('continuidade pós-tool do Gemini Live', () => {
  it('recebe e limpa o evento IPC de conclusão correlacionada', () => {
    expect(controllerSource).toContain('onLiveToolTurnComplete((event) =>');
    expect(controllerSource).toContain('notifyLiveToolTurnComplete(event);');
    expect(controllerSource).toContain('unsubLiveToolTurnComplete();');
  });

  it('mantém a guarda do dono realtime-tool ao reabrir o microfone', () => {
    expect(finishSource).toContain("turnExecution.owner === 'realtime-tool'");
    expect(finishSource).toContain('releaseAfterLiveToolAnswer({');
    expect(finishSource).toContain('callId,');
  });

  it('encerra a captura ativa assim que a tool correlacionada termina', () => {
    const completionIdx = controllerSource.indexOf(
      'onLiveToolTurnComplete((event) =>',
    );
    const completionBlock = controllerSource.slice(completionIdx, completionIdx + 2_200);

    expect(completionIdx).toBeGreaterThanOrEqual(0);
    expect(completionBlock).toContain('lastRealtimeNativeToolCallId === event.callId');
    expect(completionBlock).toContain(
      "turnExecution.isOwnedBy('realtime-tool', turnToken)",
    );
    expect(completionBlock).toContain('isListening(capture.current)');
    expect(completionBlock).toContain('finishAndProcessFacade(capture.current, busy)');
  });

  it('reabre continuidade quando uma tool local termina sem captura ativa', () => {
    const completionIdx = controllerSource.indexOf(
      'onLiveToolTurnComplete((event) =>',
    );
    const completionBlock = controllerSource.slice(completionIdx, completionIdx + 3_500);

    expect(completionBlock).toContain('releaseAfterLiveToolAnswer({');
    expect(completionBlock).toContain('audioAlreadyDrained: usedLocalNarration');
    expect(completionBlock).toContain('if (!busy.current && capture.current)');
  });

  it('libera uma tool já concluída antes de esperar transcript ou timeout', () => {
    const earlyOwnerIdx = finishSource.indexOf(
      "turnExecution.isOwnedBy('realtime-tool', turnToken)",
    );
    const transcriptWaitIdx = finishSource.indexOf('realtimeTranscriptWaiter.wait(');

    expect(earlyOwnerIdx).toBeGreaterThanOrEqual(0);
    expect(transcriptWaitIdx).toBeGreaterThanOrEqual(0);
    expect(earlyOwnerIdx).toBeLessThan(transcriptWaitIdx);
  });
});

describe('follow-up Live não compete com uma tool que já possui o turno', () => {
  it('só arma continuidade quando o caminho realmente conquistou o áudio realtime', () => {
    const claimIdx = finishSource.indexOf("const claimed = turnExecution.claim('realtime-audio', turnToken);");
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    const replyReleaseIdx = finishSource.indexOf('releaseAfterLiveProviderAnswer({', claimIdx);
    expect(replyReleaseIdx).toBeGreaterThan(claimIdx);
    const releaseBlock = finishSource.slice(replyReleaseIdx, replyReleaseIdx + 260);
    expect(releaseBlock).toContain('armFollowUp: claimed');
  });
});
