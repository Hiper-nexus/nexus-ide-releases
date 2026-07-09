# JARVIS C3 Hardening Follow-ups Implementation Plan (parte 2/2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Parte 1 (Goal, Global Constraints, Tasks 1-3):** `2026-07-09-jarvis-c3-hardening-followups.md`. As Global Constraints da parte 1 valem para TODAS as tasks abaixo. Tasks 4-6 assumem Tasks 1-3 commitadas.

---

### Task 4: Alvo de send_to_pane no renderer — só pane de agente + aviso de pane sumido (follow-ups 2 camada B + 4b)

Defesa em profundidade no executor: `action.paneId` só vale se o pane existir E for agente/orquestrador (nunca shell/browser). E `paneId` presente NUNCA cai no gate de delegação: se o pane sumiu, JARVIS avisa e re-pergunta (4b) em vez de propor mandar a RESPOSTA como missão pro squad.

**Files:**
- Create: `src/renderer/voice/send-to-pane-target.ts`
- Modify: `src/renderer/voice/jarvis-action-executor.ts:30-38,457-501`
- Test: `src/renderer/voice/send-to-pane-target.test.ts` (novo)

**Interfaces:**
- Consumes: `listPanes(root)` do executor (panes com `{ id, title, kind, orchRequestId? }`).
- Produces (de `send-to-pane-target.ts`):
  - `interface SendToPanePaneLike { id: string; title: string; kind: string; orchRequestId?: string }`
  - `isOrchestratorPane(pane: SendToPanePaneLike): boolean`
  - `isAgentTargetPane(pane: SendToPanePaneLike): boolean`
  - `type SendToPaneTarget = { kind: 'asking-pane'; paneId: string } | { kind: 'asking-pane-gone' } | { kind: 'asking-pane-not-agent'; title: string } | { kind: 'delegation'; orchestratorPaneId: string } | { kind: 'no-agent-pane' }`
  - `resolveSendToPaneTarget(requestedPaneId: string | undefined, panes: SendToPanePaneLike[]): SendToPaneTarget`

- [ ] **Step 1: Escrever os testes que falham**

Criar `src/renderer/voice/send-to-pane-target.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  isAgentTargetPane,
  isOrchestratorPane,
  resolveSendToPaneTarget,
} from './send-to-pane-target';

const shell = { id: 'p-shell', title: 'zsh', kind: 'shell' };
const browser = { id: 'p-web', title: 'docs', kind: 'browser' };
const agent = { id: 'p-agent', title: 'claude · worker', kind: 'cli-agent' };
const orch = { id: 'p-orq', title: 'orq · squad', kind: 'shell', orchRequestId: 'squad-1' };
const panes = [shell, browser, agent, orch];

describe('isOrchestratorPane / isAgentTargetPane', () => {
  it('orquestrador por orchRequestId squad- ou título orq', () => {
    expect(isOrchestratorPane(orch)).toBe(true);
    expect(isOrchestratorPane({ id: 'x', title: 'orq · missão', kind: 'shell' })).toBe(true);
    expect(isOrchestratorPane(shell)).toBe(false);
  });

  it('alvo de agente = cli-agent OU orquestrador; shell/browser NUNCA', () => {
    expect(isAgentTargetPane(agent)).toBe(true);
    expect(isAgentTargetPane(orch)).toBe(true);
    expect(isAgentTargetPane(shell)).toBe(false);
    expect(isAgentTargetPane(browser)).toBe(false);
  });
});

describe('resolveSendToPaneTarget (C3 follow-ups 2 + 4b)', () => {
  it('paneId de pane de agente vivo → asking-pane (relay direto, sem Confirmo?)', () => {
    expect(resolveSendToPaneTarget('p-agent', panes)).toEqual({
      kind: 'asking-pane',
      paneId: 'p-agent',
    });
  });

  it('paneId que sumiu → asking-pane-gone (avisa; NUNCA cai no gate de delegação)', () => {
    expect(resolveSendToPaneTarget('p-morto', panes)).toEqual({ kind: 'asking-pane-gone' });
  });

  it('paneId apontando pra shell → asking-pane-not-agent (injeção bloqueada)', () => {
    expect(resolveSendToPaneTarget('p-shell', panes)).toEqual({
      kind: 'asking-pane-not-agent',
      title: 'zsh',
    });
  });

  it('sem paneId → delegação pro orquestrador (gate de voz), ou no-agent-pane', () => {
    expect(resolveSendToPaneTarget(undefined, panes)).toEqual({
      kind: 'delegation',
      orchestratorPaneId: 'p-orq',
    });
    expect(resolveSendToPaneTarget(undefined, [shell, browser])).toEqual({
      kind: 'no-agent-pane',
    });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/renderer/voice/send-to-pane-target.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Criar o módulo puro**

Criar `src/renderer/voice/send-to-pane-target.ts`:

```ts
/**
 * C3 defesa em profundidade (follow-ups 2 e 4b): decide o destino de um
 * send_to_pane SEM efeitos. Um paneId explícito (resposta roteada de pergunta
 * pendente) só vale se o pane ainda existir E for pane de agente/orquestrador —
 * jamais escrita direta em shell/browser. E paneId presente NUNCA cai no gate
 * de delegação: pane sumido vira aviso + re-pergunta, não "Confirmo?" da
 * resposta como se fosse missão nova.
 */

export interface SendToPanePaneLike {
  id: string;
  title: string;
  kind: string;
  orchRequestId?: string;
}

const ORCH_TITLE_RE = /(^|[ ·])orq\b/i;

export function isOrchestratorPane(pane: SendToPanePaneLike): boolean {
  return Boolean(pane.orchRequestId?.startsWith('squad-')) || ORCH_TITLE_RE.test(pane.title);
}

/** Pane que pode receber texto autorado por LLM/roteado: agente CLI ou orquestrador. */
export function isAgentTargetPane(pane: SendToPanePaneLike): boolean {
  return pane.kind === 'cli-agent' || isOrchestratorPane(pane);
}

export type SendToPaneTarget =
  | { kind: 'asking-pane'; paneId: string }
  | { kind: 'asking-pane-gone' }
  | { kind: 'asking-pane-not-agent'; title: string }
  | { kind: 'delegation'; orchestratorPaneId: string }
  | { kind: 'no-agent-pane' };

export function resolveSendToPaneTarget(
  requestedPaneId: string | undefined,
  panes: SendToPanePaneLike[],
): SendToPaneTarget {
  if (requestedPaneId) {
    const pane = panes.find((p) => p.id === requestedPaneId);
    if (!pane) return { kind: 'asking-pane-gone' };
    if (!isAgentTargetPane(pane)) return { kind: 'asking-pane-not-agent', title: pane.title };
    return { kind: 'asking-pane', paneId: pane.id };
  }
  const orchestrator = panes.find(isOrchestratorPane);
  if (!orchestrator) return { kind: 'no-agent-pane' };
  return { kind: 'delegation', orchestratorPaneId: orchestrator.id };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/renderer/voice/send-to-pane-target.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire do branch send_to_pane no executor**

Em `src/renderer/voice/jarvis-action-executor.ts`:

(a) ADICIONAR ao bloco de imports:

```ts
import { isOrchestratorPane, resolveSendToPaneTarget } from './send-to-pane-target';
```

(b) SIMPLIFICAR o `findOrchestratorPane` local (linhas 30-38) para reusar o predicado:

```ts
function findOrchestratorPane(
  root: ReturnType<typeof useLayoutStore.getState>['root'],
): string | null {
  return listPanes(root).find(isOrchestratorPane)?.id ?? null;
}
```

(c) SUBSTITUIR o branch inteiro `} else if (action.type === 'send_to_pane') { ... }` (linhas 457-501) por:

```ts
  } else if (action.type === 'send_to_pane') {
    const { root } = useLayoutStore.getState();
    // NEW-B + C3 (follow-ups 2/4b): resposta roteada de pergunta pendente
    // (paneId presente) escreve de volta SÓ em pane de agente/orquestrador
    // vivo; pane sumido/inválido AVISA e re-pergunta — nunca vira "Confirmo?"
    // da resposta nem escrita em shell. Delegação (sem paneId) segue no gate
    // de confirmação por voz; o fallback silencioso pro pane focado fica morto.
    const target = resolveSendToPaneTarget(action.paneId, listPanes(root));
    if (target.kind === 'asking-pane') {
      const ok = writeToPane(target.paneId, `${action.text}\n`);
      if (!ok) sayText = 'Não consegui escrever no pane.';
      toolResult = {
        tool: action.type,
        ok,
        summary: ok ? 'resposta enviada ao pane' : 'falha ao escrever no pane',
      };
    } else if (target.kind === 'asking-pane-gone') {
      sayText =
        'O pane que tinha perguntado já fechou. Se ainda precisar, me diz de novo o que fazer.';
      expectReply = true;
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'pane da pergunta fechado — resposta não roteada',
      };
    } else if (target.kind === 'asking-pane-not-agent') {
      sayText = 'Esse pane não é de agente — não escrevo comando nele.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: `alvo não é pane de agente: ${target.title}`,
      };
    } else if (target.kind === 'no-agent-pane') {
      sayText =
        'Não achei um pane de agente pra receber a missão — abre o orquestrador primeiro.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'sem pane de agente válido (fallback silencioso bloqueado)',
      };
    } else {
      // C3: delegação NÃO dispara direto — arma a pendência e pergunta.
      setPendingDelegation({
        targetPaneId: target.orchestratorPaneId,
        text: action.text,
        createdAt: Date.now(),
      });
      sayText = delegationConfirmPrompt(action.text);
      expectReply = true;
      toolResult = {
        tool: action.type,
        ok: true,
        summary: 'missão aguardando confirmação por voz',
      };
    }
  }
```

- [ ] **Step 6: Rodar suíte + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / sem erros. (Se `tsc` reclamar da atribuição de `listPanes(root)` a `SendToPanePaneLike[]` por causa do union de `kind`, é compatível estruturalmente — `kind: string` é mais largo; NÃO estreitar o tipo do módulo novo.)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/voice/send-to-pane-target.ts src/renderer/voice/send-to-pane-target.test.ts src/renderer/voice/jarvis-action-executor.ts
git commit -m "fix(voice): send_to_pane com paneId exige pane de agente vivo; pane sumido avisa em vez de virar delegação (C3 follow-ups 2/4b)"
```

---

### Task 5: Testes de integração da interceptação + wiring do guard Live→Classic (follow-up 3 i/ii)

Cobrir com testes reais o que hoje só existe por inspeção: (i) `runJarvisTurn` intercepta a resposta da pendência ANTES do cérebro (dispatch escreve no pane, cancel não escreve, drop avisa e segue pro cérebro); (ii) `finishAndProcess` força a PRIMEIRA fala pós-"Confirmo?" pro caminho Classic (nunca pro provider Live) e `beginListening` não limpa mais a pendência.

**Files:**
- Test: `src/renderer/voice/delegation-interception.test.ts` (novo — integração com mocks de efeito)
- Test: `src/renderer/voice/delegation-flow-wiring.test.ts` (novo — source-shape, padrão de `click-wake-order.test.ts`)

**Interfaces:**
- Consumes: `runJarvisTurn(transcript, capture, busy, turnToken, deps)` real; `setPendingDelegation`/`peekPendingDelegation`/`clearPendingDelegation` reais; `DelegationReply.kind === 'drop'` (Task 2).
- Produces: nada de runtime — só cobertura.

- [ ] **Step 1: Escrever o teste de integração da interceptação**

Criar `src/renderer/voice/delegation-interception.test.ts`:

```ts
/**
 * Integração da interceptação C3 em runJarvisTurn (follow-up 3i): módulo REAL
 * de delegation-confirm + runJarvisTurn real; TODOS os efeitos (stores, IPC,
 * TTS, pane) são mocks. Prova: dispatch escreve no pane e pula o cérebro;
 * cancel não escreve; drop avisa no HUD e SEGUE pro cérebro.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';

const setStatus = vi.fn();
const setSpoken = vi.fn();
const setNote = vi.fn();
const storeState = {
  setStatus,
  setSpoken,
  setNote,
  status: 'idle',
  info: undefined,
} as Record<string, unknown>;

vi.mock('./voice-store', () => ({
  useVoiceStore: { getState: () => storeState },
}));
vi.mock('../state/gamification-store', () => ({
  useGamificationStore: { getState: () => ({ receive: vi.fn() }) },
}));
const writeToPane = vi.fn(() => true);
vi.mock('../terminal/terminal-host', () => ({
  writeToPane: (...a: unknown[]) => writeToPane(...(a as [])),
  getPaneSessionId: vi.fn(() => null),
}));
vi.mock('../state/layout-store', () => ({
  useLayoutStore: { getState: () => ({ focusedPaneId: null, root: null }) },
}));
vi.mock('../state/session-state-store', () => ({
  useSessionStateStore: { subscribe: vi.fn(() => () => {}) },
}));
vi.mock('./jarvis-screen-context', () => ({
  buildJarvisContext: () => ({}),
  findOrchestratorPane: () => null,
}));
const logVoiceEvent = vi.fn();
const liveEndTurn = vi.fn();
vi.mock('./voice-live-ipc', () => ({
  liveEndTurn: (...a: unknown[]) => liveEndTurn(...(a as [])),
  liveStatus: vi.fn(),
  logVoiceEvent: (...a: unknown[]) => logVoiceEvent(...(a as [])),
  queueLiveContextRefresh: vi.fn(),
}));
vi.mock('./voice-session-state', () => ({
  activeCaptureReason: 'reply',
  jarvisHistory: [],
  jarvisLastTurnAt: 0,
  livePlayer: null,
  realtimeTurnActive: false,
  setJarvisHistory: vi.fn(),
  setJarvisLastTurnAt: vi.fn(),
  setSuppressRealtimeAudioOut: vi.fn(),
  turnExecution: { currentToken: 1, claim: vi.fn(() => true), owner: null },
  wakeMic: { suppressWakeDetection: vi.fn() },
}));
vi.mock('./voice-realtime-gates', () => ({
  isJarvisLiveEnabled: () => false,
  isRealtimeLive: () => false,
  canAttemptRealtime: () => false,
}));
vi.mock('./voice-speak-pipeline', () => ({
  speakAndPlayPipelined: vi.fn(async () => ({ ok: true, cancelled: false, playedMs: 100 })),
  withTimeout: <T,>(p: Promise<T>) => p,
}));
vi.mock('./voice-realtime-tools', () => ({
  executeJarvisActionForTurn: vi.fn(async (reply: { say: string }) => ({
    sayText: reply.say,
    toolResult: null,
  })),
  speakViaLiveProvider: vi.fn(async () => false),
}));
vi.mock('./jarvis-reply-loop', () => ({
  delay: async () => {},
  noteAutoReplyOpened: vi.fn(),
  shouldReopenJarvisListening: () => false,
}));
vi.mock('./voice-echo-guard', () => ({
  buildReplyAutoStop: vi.fn(),
  REPLY_MIN_LISTEN_MS: 0,
}));
vi.mock('./voice-suppression-window', () => ({
  estimatedSpeechMs: () => 0,
  playbackWakeSuppressionMs: () => 0,
  replyReopenDelayMs: () => 0,
  TTS_TAIL_GUARD_MS: 0,
}));
vi.mock('./response-echo', () => ({ stripPromptEcho: (b: string) => b }));

import { runJarvisTurn, type RunJarvisTurnDeps } from './voice-run-jarvis-turn';
import {
  clearPendingDelegation,
  peekPendingDelegation,
  setPendingDelegation,
} from './delegation-confirm';
import type { VoiceCapture } from './voice-capture';

const brain = vi.fn(async () => ({ say: 'resposta do cérebro', action: { type: 'none' } }));

const deps: RunJarvisTurnDeps = {
  beginListening: vi.fn(async () => {}),
  isListening: () => false,
  finishAndProcess: vi.fn(async () => {}),
};

function busyRef(): React.MutableRefObject<boolean> {
  return { current: true };
}

async function turn(transcript: string): Promise<void> {
  await runJarvisTurn(transcript, {} as VoiceCapture, busyRef(), 1, deps);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingDelegation();
  vi.stubGlobal('window', {
    nexus: {
      voice: {
        liveInterrupt: vi.fn(async () => {}),
        recordEcho: vi.fn(async () => {}),
        jarvis: brain,
      },
      gamification: { recordJarvisAction: vi.fn(async () => ({})) },
    },
  });
});

const pending = () =>
  setPendingDelegation({ targetPaneId: 'pane-orq', text: 'Fix login bug', createdAt: Date.now() });

describe('interceptação C3 em runJarvisTurn (follow-up 3i)', () => {
  it('"sim" com pendência → escreve no pane alvo e NUNCA chama o cérebro', async () => {
    pending();
    await turn('sim');
    expect(writeToPane).toHaveBeenCalledWith('pane-orq', 'Fix login bug\n');
    expect(brain).not.toHaveBeenCalled();
    expect(peekPendingDelegation(Date.now())).toBeNull();
  });

  it('"não, cancela" com pendência → não escreve, não chama o cérebro', async () => {
    pending();
    await turn('não, cancela');
    expect(writeToPane).not.toHaveBeenCalled();
    expect(brain).not.toHaveBeenCalled();
    expect(logVoiceEvent).toHaveBeenCalledWith(
      'info',
      'jarvis.delegationCancelled',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('outro assunto com pendência → drop AVISADO no HUD e o turno segue pro cérebro', async () => {
    pending();
    await turn('abre o navegador pra mim');
    expect(writeToPane).not.toHaveBeenCalled();
    expect(setNote).toHaveBeenCalledWith(expect.stringContaining('descartada'));
    expect(logVoiceEvent).toHaveBeenCalledWith(
      'info',
      'jarvis.delegationDropped',
      expect.any(String),
      expect.any(Object),
    );
    expect(brain).toHaveBeenCalledTimes(1);
    expect(peekPendingDelegation(Date.now())).toBeNull();
  });

  it('sem pendência, "sim" é turno normal → cérebro chamado', async () => {
    await turn('sim');
    expect(brain).toHaveBeenCalledTimes(1);
    expect(writeToPane).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e ver passar**

Run: `npx vitest run src/renderer/voice/delegation-interception.test.ts`
Expected: PASS (Tasks 1-2 já implementadas; se falhar, o wiring está quebrado — corrigir o CÓDIGO, não o teste). Se algum mock não bater com um import real (export faltando), completar o mock — o vitest aponta o nome ausente.

- [ ] **Step 3: Escrever o teste de wiring (source-shape) do fluxo**

Criar `src/renderer/voice/delegation-flow-wiring.test.ts`:

```ts
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
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/renderer/voice/delegation-flow-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/voice/delegation-interception.test.ts src/renderer/voice/delegation-flow-wiring.test.ts
git commit -m "test(voice): integração da interceptação C3 (dispatch/cancel/drop) + wiring do guard Live→Classic (follow-up 3)"
```

---

### Task 6: Watchdog de 'speaking' considera playback clássico (follow-up 5 + wiring 3iii)

O re-arm do watchdog só olha áudio do Live (`livePlayer`/`pendingRealtimeAudioOut`); um TTS clássico >90s forçaria idle no meio da fala. O sinal já existe: `isLocalAudioAudible` é alimentado por `playAudioBase64` (`voice-playback.ts:80`). Extrair a decisão para um helper puro e testar também o wiring force-idle→busy.

**Files:**
- Modify: `src/renderer/voice/status-watchdog.ts`
- Modify: `src/renderer/voice/voice-controller.ts:362-383`
- Test: `src/renderer/voice/status-watchdog.test.ts`

**Interfaces:**
- Consumes: `isLocalAudioAudible(now: number): boolean` (já importado no controller), `livePlayer?.remainingMs()`, `pendingRealtimeAudioOut.length`.
- Produces: `speakingHasAudioProgress(signals: { liveRemainingMs: number; pendingLiveChunks: number; localAudioAudible: boolean }): boolean` em `status-watchdog.ts`.

- [ ] **Step 1: Escrever os testes que falham**

Em `src/renderer/voice/status-watchdog.test.ts`, ADICIONAR os imports no topo (junto aos existentes) e os describes ao final:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { speakingHasAudioProgress } from './status-watchdog';

describe('speakingHasAudioProgress (follow-up 5)', () => {
  it('áudio Live tocando/pendente OU TTS clássico audível = progresso (re-arma o relógio)', () => {
    expect(
      speakingHasAudioProgress({ liveRemainingMs: 500, pendingLiveChunks: 0, localAudioAudible: false }),
    ).toBe(true);
    expect(
      speakingHasAudioProgress({ liveRemainingMs: 0, pendingLiveChunks: 3, localAudioAudible: false }),
    ).toBe(true);
    expect(
      speakingHasAudioProgress({ liveRemainingMs: 0, pendingLiveChunks: 0, localAudioAudible: true }),
    ).toBe(true);
  });

  it('sem nenhum áudio = sem progresso (o deadline de speaking conta)', () => {
    expect(
      speakingHasAudioProgress({ liveRemainingMs: 0, pendingLiveChunks: 0, localAudioAudible: false }),
    ).toBe(false);
  });
});

describe('wiring do watchdog no voice-controller (follow-up 3iii)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf-8');

  it('o tick usa speakingHasAudioProgress com os 3 sinais (Live + clássico)', () => {
    expect(source).toContain('speakingHasAudioProgress({');
    expect(source).toContain('localAudioAudible: isLocalAudioAudible(Date.now())');
  });

  it('force-idle LIBERA busy antes de setar idle (pipeline nunca fica preso)', () => {
    const tickIdx = source.indexOf("statusWatchdogAction(watchedStatus, stuckMs) === 'force-idle'");
    expect(tickIdx).toBeGreaterThanOrEqual(0);
    const busyIdx = source.indexOf('busy.current = false;', tickIdx);
    const idleIdx = source.indexOf("setStatus('idle')", tickIdx);
    expect(busyIdx).toBeGreaterThan(tickIdx);
    expect(idleIdx).toBeGreaterThan(busyIdx);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/renderer/voice/status-watchdog.test.ts`
Expected: FAIL — `speakingHasAudioProgress` não existe.

- [ ] **Step 3: Implementar o helper puro**

Em `src/renderer/voice/status-watchdog.ts`, ADICIONAR ao final:

```ts
export interface SpeakingProgressSignals {
  /** Áudio Live restante no player (ms). */
  liveRemainingMs: number;
  /** Chunks Live retidos aguardando o gate. */
  pendingLiveChunks: number;
  /** TTS/ack CLÁSSICO ainda audível (janela do live-local-audio-gate). */
  localAudioAudible: boolean;
}

/**
 * Follow-up 5: fala longa é progresso, não travamento — e isso vale para o
 * playback CLÁSSICO também, não só o Live. Um TTS clássico >90s não pode ser
 * force-idled no meio da frase.
 */
export function speakingHasAudioProgress(signals: SpeakingProgressSignals): boolean {
  return (
    signals.liveRemainingMs > 0 ||
    signals.pendingLiveChunks > 0 ||
    signals.localAudioAudible
  );
}
```

- [ ] **Step 4: Wire no tick do controller**

Em `src/renderer/voice/voice-controller.ts`:

(a) ADICIONAR `speakingHasAudioProgress` ao import de `./status-watchdog`:

```ts
import {
  STATUS_WATCHDOG_POLL_MS,
  speakingHasAudioProgress,
  statusWatchdogAction,
} from './status-watchdog';
```

(b) SUBSTITUIR no tick (linhas 362-372):

```ts
    const statusWatchdogTimer = setInterval(() => {
      // Fala longa do Live é progresso, não travamento: enquanto há áudio
      // tocando ou pendente, o relógio do watchdog re-arma (senão uma resposta
      // contínua de 90s+ dispararia force-idle no meio da frase).
      if (
        watchedStatus === 'speaking' &&
        ((livePlayer?.remainingMs() ?? 0) > 0 || pendingRealtimeAudioOut.length > 0)
      ) {
        watchedStatusAt = Date.now();
        return;
      }
```

por:

```ts
    const statusWatchdogTimer = setInterval(() => {
      // Fala longa (Live OU clássica) é progresso, não travamento: enquanto há
      // áudio tocando/pendente o relógio re-arma (senão uma resposta contínua
      // de 90s+ dispararia force-idle no meio da frase). Follow-up 5: o TTS
      // clássico conta via isLocalAudioAudible.
      if (
        watchedStatus === 'speaking' &&
        speakingHasAudioProgress({
          liveRemainingMs: livePlayer?.remainingMs() ?? 0,
          pendingLiveChunks: pendingRealtimeAudioOut.length,
          localAudioAudible: isLocalAudioAudible(Date.now()),
        })
      ) {
        watchedStatusAt = Date.now();
        return;
      }
```

- [ ] **Step 5: Rodar suíte completa + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/voice/status-watchdog.ts src/renderer/voice/status-watchdog.test.ts src/renderer/voice/voice-controller.ts
git commit -m "fix(voice): watchdog de speaking re-arma com TTS clássico audível (follow-up 5) + teste do wiring force-idle"
```

---

## Cobertura spec → task

| Follow-up | Task |
|---|---|
| 1 (MEDIUM) AFFIRMATIVE_RE largo demais | Task 1 |
| 2 (Important) askingPane confia em paneId | Task 3 (main, registro autoritativo) + Task 4 (renderer, defesa em profundidade) |
| 3 (Minor) testes: interceptação, guard Live→Classic, watchdog wiring | Task 5 (i, ii) + Task 6 Step 1 (iii) |
| 4 (Minor) re-prompt quando missão descartada | Task 2 (4a: re-wake confirma; drop avisa) + Task 4 (4b: pane sumido avisa e re-pergunta) |
| 5 (Minor) watchdog ignora playback clássico | Task 6 |
