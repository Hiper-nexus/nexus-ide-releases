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
    const branchIdx = finishSource.indexOf(
      "turnExecution.isOwnedBy('realtime-tool', turnToken)",
    );
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(finishSource.slice(branchIdx, branchIdx + 220)).toContain(
      'hasRealtimeNativeToolSince(tRealtime)',
    );
    const clearIdx = finishSource.indexOf('clearPendingDelegation()', branchIdx);
    const dropLogIdx = finishSource.indexOf("'jarvis.delegationDropped'", branchIdx);
    const releaseIdx = finishSource.indexOf('releaseAfterRealtimeTool();', branchIdx);
    expect(clearIdx).toBeGreaterThan(branchIdx);
    expect(dropLogIdx).toBeGreaterThan(branchIdx);
    expect(finishSource.slice(branchIdx, clearIdx)).toContain(
      'shouldDiscardPendingDelegationAfterUnrelatedTool',
    );
    // Descarte (clear + log) acontece antes do release que encerra o turno.
    expect(releaseIdx).toBeGreaterThan(clearIdx);
    expect(releaseIdx).toBeGreaterThan(dropLogIdx);
    const toolBranch = finishSource.slice(branchIdx, finishSource.indexOf('if (liveTranscript)', branchIdx));
    // Ferramentas podem narrar áudio depois do resultado; a reabertura agora
    // espera o completion correlacionado em vez de abrir cedo ou dormir.
    expect(toolBranch).toContain('releaseAfterRealtimeTool();');
  });
});

describe('confirmação de delegação possui o próximo sim/não', () => {
  it('arma autoridade quando cria a pendência e resolve o fallback passivo no Classic', () => {
    const pendingIdx = executorSource.indexOf('setPendingDelegation({');
    const authorityIdx = executorSource.indexOf('followUpAuthority.arm()', pendingIdx);
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    expect(authorityIdx).toBeGreaterThan(pendingIdx);
    expect(executorSource).toContain('jarvis.delegationAuthorityArmed');
    expect(controllerSource).toContain('isPendingDelegationConfirmation(text, Date.now())');
    expect(controllerSource).toContain("via: 'pending-delegation-reply'");
    expect(controllerSource).toContain('utterance.rawMaxRms < HOT_COMMAND_MIN_PEAK_RMS');
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
