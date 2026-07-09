# JARVIS Phase 0 — Unblock + Kill the CRITICALs — Implementation Plan (Part 2/2: Tasks 4-5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Part 1 (Goal, Global Constraints, Tasks 1-3):** `docs/superpowers/plans/2026-07-09-jarvis-phase0-unblock.md` — the Global Constraints section there applies to every task here.

---

### Task 4: send_to_pane — target verification + voice confirmation (spec C3)

Today (`jarvis-action-executor.ts:456-472`) an LLM-authored mission is typed into a pane with NO confirmation, and the target silently falls back `askingPane → orchestrator → focusedPane` — a coding brief can land in a bare bash shell, or fire on a misheard/injected utterance. Owner decision (spec §1): VOICE confirmation ("Confirmo?") for delegation; the silent focused-pane fallback dies (audible refusal instead). Destructive actions keep the native modal — untouched here.

Flow after this task: `send_to_pane` → validate target (askingPane or orchestrator pane ONLY) → store a pending delegation + speak "Vou mandar pro squad: … Confirmo?" (`expectReply=true` reopens the mic) → the NEXT utterance is intercepted BEFORE the brain: "sim" dispatches, "não" cancels, anything else drops the pending mission and flows to the brain normally. A pending confirmation also forces the Live path to route the reply to Classic (so the provider can't swallow the "sim").

**Files:**
- Create: `src/renderer/voice/delegation-confirm.ts`
- Create: `src/renderer/voice/delegation-confirm.test.ts`
- Modify: `src/renderer/voice/jarvis-action-executor.ts` (branch at L456-472; `let sayText`/`let expectReply` are at L185-186)
- Modify: `src/renderer/voice/voice-run-jarvis-turn.ts` (interception right after L86 `isTurnCurrent` definition, before the brain call at L93-99)
- Modify: `src/renderer/voice/voice-finish-and-process.ts` (Live-path guard before the `shouldLetRealtimeProviderAnswer` check at L261-265)

**Interfaces:**
- Consumes: `writeToPane(paneId, text): boolean` (`../terminal/terminal-host` — ALREADY imported in voice-run-jarvis-turn at L10); `findOrchestratorPane(root)` (local in executor, L29); `speakAndPlayPipelined(sayText, isTurnCurrent)` (`./voice-speak-pipeline`, returns `{ ok, cancelled?, playedMs, error? }` — mirror its usage at run-jarvis-turn L193-206); suppression helpers already imported in run-jarvis-turn (L48-53).
- Produces (from `delegation-confirm.ts`):
  - `interface PendingDelegation { targetPaneId: string; text: string; createdAt: number }`
  - `DELEGATION_CONFIRM_TTL_MS = 45_000`, `CONFIRM_SUMMARY_MAX_CHARS = 80`
  - `setPendingDelegation(d: PendingDelegation): void`, `peekPendingDelegation(now: number): PendingDelegation | null`, `clearPendingDelegation(): void`
  - `classifyConfirmationReply(text: string): 'yes' | 'no' | 'other'`
  - `resolveDelegationReply(transcript: string, now: number): { kind: 'dispatch'; delegation: PendingDelegation } | { kind: 'cancel' } | { kind: 'none' }`
  - `delegationConfirmPrompt(text: string): string`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/voice/delegation-confirm.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyConfirmationReply,
  clearPendingDelegation,
  DELEGATION_CONFIRM_TTL_MS,
  delegationConfirmPrompt,
  peekPendingDelegation,
  resolveDelegationReply,
  setPendingDelegation,
} from './delegation-confirm';

const T0 = 1_000_000;

beforeEach(() => clearPendingDelegation());

describe('classifyConfirmationReply', () => {
  it('afirmativas PT-BR viram yes', () => {
    for (const t of ['sim', 'pode mandar', 'confirmo', 'manda ver', 'beleza', 'ok']) {
      expect(classifyConfirmationReply(t)).toBe('yes');
    }
  });

  it('negativas viram no — e negativa GANHA de afirmativa ("não pode")', () => {
    for (const t of ['não', 'nao pode', 'cancela', 'espera', 'melhor não, deixa']) {
      expect(classifyConfirmationReply(t)).toBe('no');
    }
  });

  it('resto é other (mudou de assunto)', () => {
    expect(classifyConfirmationReply('abre o navegador pra mim')).toBe('other');
    expect(classifyConfirmationReply('')).toBe('other');
  });
});

describe('pending delegation lifecycle', () => {
  const delegation = {
    targetPaneId: 'pane-1',
    text: 'Fix the flaky test in auth',
    createdAt: T0,
  };

  it('sim → dispatch com a delegação, e limpa o estado', () => {
    setPendingDelegation(delegation);
    const r = resolveDelegationReply('sim, pode mandar', T0 + 1_000);
    expect(r).toEqual({ kind: 'dispatch', delegation });
    expect(peekPendingDelegation(T0 + 2_000)).toBeNull();
  });

  it('não → cancel, e limpa', () => {
    setPendingDelegation(delegation);
    expect(resolveDelegationReply('não, cancela', T0 + 1_000)).toEqual({ kind: 'cancel' });
    expect(peekPendingDelegation(T0 + 2_000)).toBeNull();
  });

  it('mudou de assunto → none, missão descartada (NUNCA despacha sem sim)', () => {
    setPendingDelegation(delegation);
    expect(resolveDelegationReply('que horas são?', T0 + 1_000)).toEqual({ kind: 'none' });
    expect(peekPendingDelegation(T0 + 2_000)).toBeNull();
  });

  it('expira após o TTL', () => {
    setPendingDelegation(delegation);
    expect(peekPendingDelegation(T0 + DELEGATION_CONFIRM_TTL_MS + 1)).toBeNull();
    expect(resolveDelegationReply('sim', T0 + DELEGATION_CONFIRM_TTL_MS + 1)).toEqual({
      kind: 'none',
    });
  });

  it('sem pendência → none', () => {
    expect(resolveDelegationReply('sim', T0)).toEqual({ kind: 'none' });
  });
});

describe('delegationConfirmPrompt', () => {
  it('fala a primeira linha truncada + Confirmo?', () => {
    const p = delegationConfirmPrompt('Implement retry logic in the queue\nDetails: ...');
    expect(p).toBe('Vou mandar pro squad: Implement retry logic in the queue. Confirmo?');
  });

  it('trunca linhas longas com reticências', () => {
    const p = delegationConfirmPrompt('x'.repeat(200));
    expect(p).toContain('…');
    expect(p.length).toBeLessThan(130);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/voice/delegation-confirm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement delegation-confirm.ts**

Create `src/renderer/voice/delegation-confirm.ts`:

```ts
/**
 * Portão de confirmação POR VOZ da delegação de código (C3): send_to_pane
 * despachava um prompt autorado por LLM sem confirmação nenhuma, com fallback
 * silencioso até o pane focado (um brief de engenharia digitado num bash puro,
 * ou disparado por fala mal-transcrita/injetada). Decisão do dono: delegação
 * confirma por voz ("Confirmo?"); modal nativo fica só para destrutivo.
 *
 * Estado mínimo de UMA pendência + classificação PURA da resposta. A resposta
 * que não for sim/não DESCARTA a missão (nunca despachar sem um "sim").
 */

export interface PendingDelegation {
  targetPaneId: string;
  text: string;
  createdAt: number;
}

export const DELEGATION_CONFIRM_TTL_MS = 45_000;
export const CONFIRM_SUMMARY_MAX_CHARS = 80;

let pending: PendingDelegation | null = null;

export function setPendingDelegation(d: PendingDelegation): void {
  pending = d;
}

export function clearPendingDelegation(): void {
  pending = null;
}

/** Pendência atual, expirando pelo TTL (uma confirmação velha não vale). */
export function peekPendingDelegation(now: number): PendingDelegation | null {
  if (pending && now - pending.createdAt > DELEGATION_CONFIRM_TTL_MS) {
    pending = null;
  }
  return pending;
}

function norm(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NEGATIVE_RE =
  /\b(nao|cancela|cancelar|espera|pera|para|deixa|esquece|negativo)\b/;
const AFFIRMATIVE_RE =
  /\b(sim|pode|confirmo|confirma|confirmado|manda|vai|bora|positivo|isso|beleza|ok|okay|claro|com certeza|demorou)\b/;

/** Negativa GANHA de afirmativa: "não pode" é não. */
export function classifyConfirmationReply(text: string): 'yes' | 'no' | 'other' {
  const n = norm(text);
  if (!n) return 'other';
  if (NEGATIVE_RE.test(n)) return 'no';
  if (AFFIRMATIVE_RE.test(n)) return 'yes';
  return 'other';
}

export type DelegationReply =
  | { kind: 'dispatch'; delegation: PendingDelegation }
  | { kind: 'cancel' }
  | { kind: 'none' };

/**
 * Resolve a fala seguinte contra a pendência. QUALQUER desfecho limpa o
 * estado: sim despacha, não cancela, outro assunto descarta a missão.
 */
export function resolveDelegationReply(
  transcript: string,
  now: number,
): DelegationReply {
  const delegation = peekPendingDelegation(now);
  if (!delegation) return { kind: 'none' };
  clearPendingDelegation();
  const reply = classifyConfirmationReply(transcript);
  if (reply === 'yes') return { kind: 'dispatch', delegation };
  if (reply === 'no') return { kind: 'cancel' };
  return { kind: 'none' };
}

/** Frase falada em PT com a primeira linha da missão (truncada). */
export function delegationConfirmPrompt(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const summary =
    firstLine.length > CONFIRM_SUMMARY_MAX_CHARS
      ? `${firstLine.slice(0, CONFIRM_SUMMARY_MAX_CHARS)}…`
      : firstLine;
  return summary
    ? `Vou mandar pro squad: ${summary}. Confirmo?`
    : 'Vou mandar a missão pro squad. Confirmo?';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/voice/delegation-confirm.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Rewire the executor branch (kill the silent fallback, arm the pending)**

In `src/renderer/voice/jarvis-action-executor.ts`, add the import at the top:

```ts
import { delegationConfirmPrompt, setPendingDelegation } from './delegation-confirm';
```

Replace the `send_to_pane` branch (L456-472), which currently reads:

```ts
  } else if (action.type === 'send_to_pane') {
    const { root, focusedPaneId } = useLayoutStore.getState();
    // NEW-B: a routed pending-question answer carries the ASKING pane — write it
    // back there. Only fall back to orchestrator/focused pane for model-emitted
    // delegation (no paneId), and only when the asking pane still exists.
    const askingPane =
      action.paneId && listPanes(root).some((pane) => pane.id === action.paneId)
        ? action.paneId
        : null;
    const target = askingPane ?? findOrchestratorPane(root) ?? focusedPaneId;
    const ok = target ? writeToPane(target, `${action.text}\n`) : false;
    if (!ok) sayText = 'Não tem nenhum pane para eu mandar a tarefa.';
    toolResult = {
      tool: action.type,
      ok,
      summary: ok ? 'tarefa enviada ao pane' : 'nenhum pane disponível',
    };
```

with:

```ts
  } else if (action.type === 'send_to_pane') {
    const { root } = useLayoutStore.getState();
    // NEW-B: a routed pending-question answer carries the ASKING pane — write it
    // back there. Model-emitted delegation (no paneId) only goes to the
    // ORCHESTRATOR pane. The old silent focused-pane fallback is dead (C3):
    // it typed engineering briefs into bare bash shells.
    const askingPane =
      action.paneId && listPanes(root).some((pane) => pane.id === action.paneId)
        ? action.paneId
        : null;
    const target = askingPane ?? findOrchestratorPane(root);
    if (!target) {
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
        targetPaneId: target,
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
```

(`sayText`/`expectReply` are the existing `let` bindings at L185-186.)

- [ ] **Step 6: Intercept the confirmation reply BEFORE the brain**

In `src/renderer/voice/voice-run-jarvis-turn.ts`, add the import (do NOT re-import `writeToPane` — it is already imported at L10):

```ts
import { resolveDelegationReply } from './delegation-confirm';
```

Inside `runJarvisTurn`, immediately after the `isTurnCurrent` definition (L86) and BEFORE `const now = Date.now();`, insert:

```ts
  // C3: se há missão aguardando "Confirmo?", esta fala é a resposta — resolve
  // ANTES do cérebro (o cérebro veria "sim" solto e responderia qualquer coisa).
  const delegationReply = resolveDelegationReply(transcript, Date.now());
  if (delegationReply.kind !== 'none') {
    let say = 'Cancelei a missão.';
    if (delegationReply.kind === 'dispatch') {
      const ok = writeToPane(
        delegationReply.delegation.targetPaneId,
        `${delegationReply.delegation.text}\n`,
      );
      say = ok
        ? 'Missão confirmada e enviada ao squad.'
        : 'Não consegui escrever no pane do squad.';
      logVoiceEvent(ok ? 'info' : 'warn', 'jarvis.delegationDispatched', say, {
        ok,
        chars: delegationReply.delegation.text.length,
      });
    } else {
      logVoiceEvent('info', 'jarvis.delegationCancelled', 'usuário recusou a missão', {});
    }
    setSuppressRealtimeAudioOut(true);
    livePlayer?.stop();
    void window.nexus.voice.liveInterrupt('classic-tts').catch(() => {});
    store.setStatus('speaking');
    const spoken = await speakAndPlayPipelined(say, isTurnCurrent);
    if (spoken.ok && !spoken.cancelled) {
      store.setSpoken(say);
      void window.nexus.voice.recordEcho(say);
      wakeMic.suppressWakeDetection(
        spoken.playedMs > 0
          ? TTS_TAIL_GUARD_MS
          : playbackWakeSuppressionMs(estimatedSpeechMs(say.length)),
      );
    }
    store.setStatus('idle');
    liveEndTurn();
    return;
  }
```

(Everything referenced — `store`, `logVoiceEvent`, `setSuppressRealtimeAudioOut`, `livePlayer`, `speakAndPlayPipelined`, `wakeMic`, `TTS_TAIL_GUARD_MS`, `playbackWakeSuppressionMs`, `estimatedSpeechMs`, `liveEndTurn`, `writeToPane` — is already imported in this file; see L8-55.)

- [ ] **Step 7: Force Classic routing for the confirmation reply on the Live path**

In `src/renderer/voice/voice-finish-and-process.ts`, add the import:

```ts
import { classifyConfirmationReply, peekPendingDelegation } from './delegation-confirm';
```

At L261-265, replace:

```ts
        if (
          REALTIME_PROVIDER_AUDIO_ENABLED &&
          shouldLetRealtimeProviderAnswer(transcript, { isRealtimeLive: isRealtimeLive() }) &&
          isRealtimeLive()
        ) {
```

with:

```ts
        // C3: resposta a um "Confirmo?" pendente NUNCA vai pro provider Live —
        // desce pro caminho Classic, onde runJarvisTurn intercepta e resolve.
        const isPendingDelegationReply =
          peekPendingDelegation(Date.now()) !== null &&
          classifyConfirmationReply(transcript) !== 'other';
        if (
          !isPendingDelegationReply &&
          REALTIME_PROVIDER_AUDIO_ENABLED &&
          shouldLetRealtimeProviderAnswer(transcript, { isRealtimeLive: isRealtimeLive() }) &&
          isRealtimeLive()
        ) {
```

- [ ] **Step 8: Typecheck + tests**

Run: `npm run typecheck && npx vitest run src/renderer/voice/delegation-confirm.test.ts && npx vitest run src/renderer/voice`
Expected: clean + PASS. The executor change alters `send_to_pane` semantics — if any existing test asserts the old direct-dispatch behavior, update THAT test to expect the pending-confirmation result, citing spec C3 in the test name.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/voice/delegation-confirm.ts src/renderer/voice/delegation-confirm.test.ts src/renderer/voice/jarvis-action-executor.ts src/renderer/voice/voice-run-jarvis-turn.ts src/renderer/voice/voice-finish-and-process.ts
git commit -m "feat(voice): voice-confirmation gate + agent-pane-only targeting for send_to_pane (kills silent bash fallback)"
```

---

### Task 5: Two-voices attribution + boot identity observability (spec Phase 0 item 6)

Before Phase 1 claims the reconnect collapse fixes "two voices", we need logs that attribute duplicate audio: internal race vs cross-app collision (the Overclock voice sidecar has independent locks). Two tiny log lines: instance identity at voice boot (main), and local playback start (renderer). If the user hears a voice at time T and `voice.log` shows no `audio.playbackStart`/`live.audioPlayed` near T, the sound came from another app.

**Files:**
- Modify: `src/main/voice/voice-ipc.ts` (inside the voice IPC registration function, right at its start — same function that registers `openMicSettings` at L284)
- Modify: `src/renderer/voice/voice-playback.ts` (inside `playAudioBase64`, after `durationMs` is computed at L63)

**Interfaces:**
- Consumes: `logVoice(level, event, msg, data)` (main, already used in voice-ipc); `window.nexus.voice.logVoice({...})` (renderer — avoids importing `voice-live-ipc` into voice-playback and any import-cycle risk).
- Produces: log events `voice.instanceBoot` and `audio.playbackStart` in `~/.nexus/logs/voice.log`.

- [ ] **Step 1: Main boot identity line**

In `src/main/voice/voice-ipc.ts`, at the START of the exported registration function (the one containing the `ipcMain.on(VOICE_CHANNELS.openMicSettings, ...)` handler), add (`app` import: extend the existing `'electron'` import if needed):

```ts
  // Atribuição de "duas vozes": identifica ESTA instância no voice.log para
  // distinguir colisão interna de colisão cross-app (sidecar do Overclock).
  logVoice('info', 'voice.instanceBoot', 'instância de voz iniciada', {
    pid: process.pid,
    execPath: process.execPath,
    version: app.getVersion(),
  });
```

- [ ] **Step 2: Renderer playback start line**

In `src/renderer/voice/voice-playback.ts`, inside `playAudioBase64` right after `const durationMs = Math.ceil(audioBuffer.duration * 1000);` (L63), add:

```ts
    // Atribuição de "duas vozes": todo áudio local audível fica no voice.log;
    // voz ouvida sem linha correspondente = veio de OUTRO app.
    window.nexus.voice.logVoice({
      level: 'info',
      event: 'audio.playbackStart',
      msg: 'playback local iniciado',
      data: { durationMs },
    });
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npm run typecheck && npm run test`
Expected: clean + full suite PASS.

Optional smoke: `tail -5 ~/.nexus/logs/voice.log` after any TTS in a running session — expect an `audio.playbackStart` entry.

- [ ] **Step 4: Commit**

```bash
git add src/main/voice/voice-ipc.ts src/renderer/voice/voice-playback.ts
git commit -m "feat(voice): instance-boot + local-playback log lines for two-voices attribution"
```

---

## Final verification (after all tasks, both parts)

- [ ] `npm run typecheck` — clean.
- [ ] `npm run test` — full suite green.
- [ ] Manual smoke (per memory `nexus-ide-multi-session-workflow`): `NEXUS_USER_DATA_DIR=/tmp/nexus-smoke npm start`, then:
  1. Wake by voice → ask for a delegation ("manda o squad corrigir X") → hear "Confirmo?" → say "sim" → verify the text lands ONLY in an orchestrator pane.
  2. Second delegation → say "não" → verify cancel is spoken and nothing is written.
  3. With no orchestrator pane open → delegation → verify the audible refusal (no write to any shell).
  4. Check `~/.nexus/logs/voice.log` for `voice.instanceBoot`, `audio.playbackStart`, and absence of `live.audioSuppressed` climbing without matching `live.audioPlayed` (the stuck-mute signature).
