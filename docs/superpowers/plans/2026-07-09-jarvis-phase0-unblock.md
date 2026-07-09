# JARVIS Phase 0 — Unblock + Kill the CRITICALs — Implementation Plan (Part 1/2: Tasks 1-3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Part 2 (Tasks 4-5 + final verification):** `docs/superpowers/plans/2026-07-09-jarvis-phase0-unblock-part2.md`

**Goal:** Make voice reachable and safe: guaranteed exit from stuck states, structural mute invariant, phantom-TCC guided recovery, and a voice-confirmation gate on code delegation — without touching the coordinator refactor (that is Phase 1).

**Architecture:** Four surgical fixes to the existing Classic/Live pipeline plus one observability slice. Each fix follows the house pattern: a small PURE module with colocated vitest tests, wired into the existing controller/executor with a minimal diff. No behavioral rewrite, no new state machine.

**Tech Stack:** TypeScript (Electron renderer + main), zustand, vitest. Spec: `docs/superpowers/specs/2026-07-09-jarvis-voice-agent-refactor-design.md` (§5 Phase 0).

## Global Constraints

- Test command: `npx vitest run <file>` (per file) and `npm run test` (suite). Typecheck: `npm run typecheck` (`tsc --noEmit`).
- TDD: write the failing test first for every pure module.
- No new `console.log` — use `logVoiceEvent(...)` (renderer, from `./voice-live-ipc`), `window.nexus.voice.logVoice({...})` (renderer without import-cycle risk), or `logVoice(...)` (main).
- All user-facing/spoken strings in PT-BR. Keep the pixel/operator aesthetic — no new UI beyond HUD banner text/buttons matching existing `voice-hud__detail`/`voice-hud__action` classes.
- Do NOT touch `voice-ipc.confirmCommand` (native confirm spine — regression there is CRITICAL per spec).
- Do NOT remove any existing `openLiveAudioGate()` call sites in this phase — they open the gate EARLY mid-turn for audibility; Task 1 only guarantees the exit path. Cleanup happens in Phase 1.
- Immutability: never mutate params; new objects on update. Files stay under 800 lines.
- Commits: conventional format (`fix:`/`feat:`/`test:`), no attribution footer.
- Context: self-talk (spec H4) is ALREADY LANDED in current code (suppression tied to measured playback in `voice-playback.ts`, local-audio mic gate in `live-local-audio-gate.ts`, consulted at `voice-controller.ts:413`) — there is deliberately no H4 task.

---

### Task 1: Mute invariant — turn-exit gate (spec C2)

The bug: `finishAndProcess` (`src/renderer/voice/voice-finish-and-process.ts`) has ~20 early returns; several set `setSuppressRealtimeAudioOut(true)` (L166, L295, L394) and then can exit without re-opening the Live audio gate — e.g. STT failure at L447-450 after the degrade at L394 leaves suppress stuck ON = permanent silence. The fix: open the gate in `finally`, but ONLY if this turn is still the current one — on the `wait.superseded` path (L171) a NEWER turn already owns suppression and we must not unmute over it.

**Files:**
- Create: `src/renderer/voice/turn-gate.ts`
- Create: `src/renderer/voice/turn-gate.test.ts`
- Modify: `src/renderer/voice/voice-finish-and-process.ts` (imports ~L46, finally block L569-577)

**Interfaces:**
- Consumes: `turnExecution.currentToken` (getter) from `voice-session-state`; `openLiveAudioGate(): void` from `voice-live-audio-out` (sets suppress=false + flushes held chunks — already idempotent).
- Produces: `shouldOpenGateOnTurnExit(currentToken: number, turnToken: number): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/voice/turn-gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { shouldOpenGateOnTurnExit } from './turn-gate';

describe('shouldOpenGateOnTurnExit', () => {
  it('opens the gate when the exiting turn is still the current one', () => {
    expect(shouldOpenGateOnTurnExit(7, 7)).toBe(true);
  });

  it('does NOT open when a newer turn superseded this one (it owns the gate now)', () => {
    expect(shouldOpenGateOnTurnExit(8, 7)).toBe(false);
  });

  it('does NOT open on a stale/foreign token', () => {
    expect(shouldOpenGateOnTurnExit(7, 9)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/voice/turn-gate.test.ts`
Expected: FAIL — `Cannot find module './turn-gate'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/voice/turn-gate.ts`:

```ts
/**
 * INVARIANTE DE MUTE (C2): um turno NUNCA pode terminar com o gate de áudio
 * Live fechado. finishAndProcess tem ~20 saídas antecipadas e várias ligam
 * suppressRealtimeAudioOut=true; uma saída esquecida = silêncio total
 * permanente (o bug de mute documentado). A abertura vai no finally — mas só
 * o turno ATUAL pode mexer no gate: se um turno mais novo nos superou
 * (wait.superseded), a supressão agora pertence a ele e desmutar por cima
 * quebraria o mute do turno novo.
 */
export function shouldOpenGateOnTurnExit(
  currentToken: number,
  turnToken: number,
): boolean {
  return currentToken === turnToken;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/voice/turn-gate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into finishAndProcess's finally**

In `src/renderer/voice/voice-finish-and-process.ts`, add the import next to the `openLiveAudioGate` import (~L46):

```ts
import { shouldOpenGateOnTurnExit } from './turn-gate';
```

Replace the existing `finally` block (currently L569-577):

```ts
  } finally {
    // Live provider answer already cleared busy via releaseAfterLiveProviderAnswer
    // and may be waiting to re-arm follow-up while status is still 'speaking'.
    // Do not leave busy stuck true on early Live returns.
    const status = useVoiceStore.getState().status;
    if (status !== 'listening') {
      busy.current = false;
    }
  }
```

with:

```ts
  } finally {
    // INVARIANTE DE MUTE (C2): nenhuma saída deste turno pode deixar
    // suppressRealtimeAudioOut preso em true. Só o turno atual toca o gate;
    // um turno mais novo (superseded) é dono da própria supressão.
    if (shouldOpenGateOnTurnExit(turnExecution.currentToken, turnToken)) {
      openLiveAudioGate();
    }
    // Live provider answer already cleared busy via releaseAfterLiveProviderAnswer
    // and may be waiting to re-arm follow-up while status is still 'speaking'.
    // Do not leave busy stuck true on early Live returns.
    const status = useVoiceStore.getState().status;
    if (status !== 'listening') {
      busy.current = false;
    }
  }
```

Note: `turnExecution` and `turnToken` are already in scope (`turnToken` is captured at L95). Do NOT remove any existing `openLiveAudioGate()` calls elsewhere in the function.

- [ ] **Step 6: Typecheck + full voice tests**

Run: `npm run typecheck && npx vitest run src/renderer/voice`
Expected: typecheck clean; all voice tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/voice/turn-gate.ts src/renderer/voice/turn-gate.test.ts src/renderer/voice/voice-finish-and-process.ts
git commit -m "fix(voice): mute invariant — open Live audio gate on every turn exit (token-aware finally)"
```

---

### Task 2: Status watchdog — guaranteed exit from stuck phases (spec C1b)

The documented latent wall: a failed/never-resolving stage can pin `VoiceUiStatus` at `transcribing`/`routing`/`speaking` (WAKE-BROKEN-001 Rank 3; the `wait.superseded` return at `voice-finish-and-process.ts:171-175` also leaves `transcribing` behind). Deadlines already bound each stage (`TRANSCRIBE_DEADLINE 60s`, `BRAIN_DEADLINE 35s`, `SPEAK_DEADLINE 40s`), so a status stuck LONGER than its stage deadline is by definition a wedge. Add a pure classifier + a controller interval that forces `idle` and releases `busy`.

**Files:**
- Create: `src/renderer/voice/status-watchdog.ts`
- Create: `src/renderer/voice/status-watchdog.test.ts`
- Modify: `src/renderer/voice/voice-controller.ts` (next to the `micHealthTimer` block, L318-343, and its effect cleanup — find `clearInterval(micHealthTimer)`)

**Interfaces:**
- Consumes: `VoiceUiStatus` type from `./voice-store`.
- Produces: `statusWatchdogAction(status: VoiceUiStatus, stuckMs: number): 'none' | 'force-idle'`; constants `STATUS_WATCHDOG_POLL_MS`, `STATUS_STUCK_DEADLINES_MS`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/voice/status-watchdog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  STATUS_STUCK_DEADLINES_MS,
  statusWatchdogAction,
} from './status-watchdog';

describe('statusWatchdogAction', () => {
  it('never fires for idle/listening/error (owned elsewhere)', () => {
    expect(statusWatchdogAction('idle', 999_999)).toBe('none');
    expect(statusWatchdogAction('listening', 999_999)).toBe('none');
    expect(statusWatchdogAction('error', 999_999)).toBe('none');
  });

  it('fires force-idle when transcribing exceeds its deadline (> STT 60s)', () => {
    const deadline = STATUS_STUCK_DEADLINES_MS.transcribing!;
    expect(statusWatchdogAction('transcribing', deadline - 1)).toBe('none');
    expect(statusWatchdogAction('transcribing', deadline)).toBe('force-idle');
  });

  it('fires for routing and speaking past their deadlines', () => {
    expect(
      statusWatchdogAction('routing', STATUS_STUCK_DEADLINES_MS.routing!),
    ).toBe('force-idle');
    expect(
      statusWatchdogAction('speaking', STATUS_STUCK_DEADLINES_MS.speaking!),
    ).toBe('force-idle');
  });

  it('all deadlines exceed the stage deadlines they guard', () => {
    expect(STATUS_STUCK_DEADLINES_MS.transcribing!).toBeGreaterThan(60_000);
    expect(STATUS_STUCK_DEADLINES_MS.routing!).toBeGreaterThan(35_000);
    expect(STATUS_STUCK_DEADLINES_MS.speaking!).toBeGreaterThan(40_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/voice/status-watchdog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/voice/status-watchdog.ts`:

```ts
/**
 * Watchdog PURO de status preso (C1b / WAKE-BROKEN-001 Rank 3): cada etapa do
 * pipeline já tem deadline próprio (STT 60s, cérebro 35s, TTS 40s), então um
 * status parado ALÉM do deadline da etapa é, por definição, um travamento —
 * ex.: STT que falha deixa 'transcribing' preso e o HUD mente para o usuário.
 * A saída forçada para 'idle' garante que nenhuma fase segure o pipeline para
 * sempre (prévia da propriedade "nunca trava" do coordenador da Fase 1).
 */
import type { VoiceUiStatus } from './voice-store';

export const STATUS_WATCHDOG_POLL_MS = 5_000;

/** Margem sobre o deadline da etapa que o status representa. */
export const STATUS_STUCK_DEADLINES_MS: Partial<Record<VoiceUiStatus, number>> = {
  transcribing: 75_000, // > TRANSCRIBE_DEADLINE_MS_LOCAL (60s)
  routing: 50_000, // > BRAIN_DEADLINE_MS_LOCAL (35s)
  speaking: 90_000, // > SPEAK_DEADLINE_MS_LOCAL (40s) + playback longo do Live
};

export function statusWatchdogAction(
  status: VoiceUiStatus,
  stuckMs: number,
): 'none' | 'force-idle' {
  const deadline = STATUS_STUCK_DEADLINES_MS[status];
  if (deadline === undefined) return 'none';
  return stuckMs >= deadline ? 'force-idle' : 'none';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/voice/status-watchdog.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into voice-controller**

In `src/renderer/voice/voice-controller.ts`:

Add import (top of file, alongside the `wake-health` import at L5):

```ts
import {
  STATUS_WATCHDOG_POLL_MS,
  statusWatchdogAction,
} from './status-watchdog';
```

Immediately AFTER the `micHealthTimer` block (after L343 `void checkMicHealth();`), add:

```ts
    // Watchdog de status preso (C1b): força idle se uma fase passar do
    // deadline da etapa — STT falho não pode deixar 'transcribing' eterno.
    let watchedStatus = useVoiceStore.getState().status;
    let watchedStatusAt = Date.now();
    const unsubStatusWatchdog = useVoiceStore.subscribe((s) => {
      if (s.status !== watchedStatus) {
        watchedStatus = s.status;
        watchedStatusAt = Date.now();
      }
    });
    const statusWatchdogTimer = setInterval(() => {
      const stuckMs = Date.now() - watchedStatusAt;
      if (statusWatchdogAction(watchedStatus, stuckMs) === 'force-idle') {
        logVoiceEvent('warn', 'voice.statusWatchdog', 'status preso — forçando idle', {
          status: watchedStatus,
          stuckMs,
        });
        busy.current = false;
        useVoiceStore.getState().setStatus('idle');
      }
    }, STATUS_WATCHDOG_POLL_MS);
```

In the SAME effect's cleanup (find `clearInterval(micHealthTimer)` in the effect's return block), add alongside it:

```ts
      clearInterval(statusWatchdogTimer);
      unsubStatusWatchdog();
```

Note: `logVoiceEvent` is already imported in voice-controller (used at L294). `busy` is the same ref used by the surrounding effect.

- [ ] **Step 6: Typecheck + tests**

Run: `npm run typecheck && npx vitest run src/renderer/voice/status-watchdog.test.ts`
Expected: clean + PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/voice/status-watchdog.ts src/renderer/voice/status-watchdog.test.ts src/renderer/voice/voice-controller.ts
git commit -m "fix(voice): status watchdog — forced exit from stuck transcribing/routing/speaking"
```

---

### Task 3: Phantom TCC grant — detection + guided reset (spec C1a / WAKE-BROKEN-001 Rank 1)

Root cause (documented with log evidence): after reinstall/update, macOS invalidates the TCC mic record for the bundle but still reports `granted`, delivering pure digital silence (`rms:0` on every frame). Current `classifyMicHealth` lumps this into `silent` ("mic mudo ou dispositivo errado") whose banner sends the user to Sound Settings — the WRONG fix. Pure zeros are distinguishable from a quiet room (ambient noise is small but nonzero): track `rms === 0` separately, classify as `phantomGrant`, and offer the documented fix (`tccutil reset Microphone <bundleId>` + relaunch + re-Allow) as a one-click guided flow.

**Files:**
- Modify: `src/renderer/voice/wake-health.ts` (add `phantomGrant` + zero params)
- Modify: `src/renderer/voice/wake-health.test.ts` (append cases)
- Modify: `src/renderer/voice/wake-mic.ts` (track `zeroSince`, expose `getZeroMs()`; onFrame is at ~L401-437, `getSilentMs()` at L143)
- Modify: `src/renderer/voice/voice-controller.ts:328` (pass zero info)
- Modify: `src/renderer/components/VoiceHud.tsx` (~L365, new banner BEFORE the `silent` one)
- Create: `src/main/voice/mic-tcc.ts` + `src/main/voice/mic-tcc.test.ts`
- Modify: `src/shared/voice-channels.ts` (add `micResetTcc: 'voice:micResetTcc'`, following the existing naming at L27)
- Modify: `src/shared/voice-ipc.ts` (voice API type: add `resetMicPermission(): Promise<{ ok: boolean; error?: string }>` next to the existing `confirmCommand` declaration — find via grep)
- Modify: `src/preload/preload.ts` (~L377-381, sibling of `openMicSettings`)
- Modify: `src/main/voice/voice-ipc.ts` (~L284, near the `openMicSettings` handler)

**Interfaces:**
- Consumes: `wakeMic.getSilentMs()` pattern (wake-mic.ts:143) as the model for `getZeroMs()`; existing HUD classes `voice-hud__detail--error`, `voice-hud__action`.
- Produces: `MicHealth` union gains `'phantomGrant'`; `classifyMicHealth(permission, silentMs, silentThresholdMs, zero?: { zeroMs: number; zeroThresholdMs?: number })`; `PHANTOM_ZERO_MS = 10_000`; `wakeMic.getZeroMs(): number`; IPC `window.nexus.voice.resetMicPermission()`; main helpers `appBundlePathFromExecPath(execPath)`, `readBundleId(appBundlePath)`, `resetMicrophoneTcc(bundleId)`.

- [ ] **Step 1: Write the failing tests (pure classification)**

Append to `src/renderer/voice/wake-health.test.ts` (match the file's existing import of `classifyMicHealth`):

```ts
describe('phantomGrant (TCC fantasma — WAKE-BROKEN-001)', () => {
  it('granted + zeros sustentados = phantomGrant (prioridade sobre silent)', () => {
    expect(
      classifyMicHealth('granted', 15_000, 12_000, {
        zeroMs: 11_000,
        zeroThresholdMs: 10_000,
      }),
    ).toBe('phantomGrant');
  });

  it('granted + silêncio ambiente (rms > 0) continua silent, não phantom', () => {
    expect(
      classifyMicHealth('granted', 15_000, 12_000, { zeroMs: 0 }),
    ).toBe('silent');
  });

  it('zeros abaixo do limiar ainda não alarmam', () => {
    expect(
      classifyMicHealth('granted', 3_000, 12_000, { zeroMs: 3_000 }),
    ).toBe('ok');
  });

  it('sem permissão ganha de phantom (o fix é outro)', () => {
    expect(
      classifyMicHealth('denied', 15_000, 12_000, { zeroMs: 15_000 }),
    ).toBe('needsPermission');
  });

  it('assinatura antiga (3 args) continua funcionando', () => {
    expect(classifyMicHealth('granted', 15_000, 12_000)).toBe('silent');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/voice/wake-health.test.ts`
Expected: FAIL on the 4-arg calls.

- [ ] **Step 3: Extend wake-health.ts**

In `src/renderer/voice/wake-health.ts`, change the `MicHealth` type and `classifyMicHealth` (keep `frameIsSilent`, `MIC_NOISE_FLOOR` untouched); update the top doc comment to mention the third deafness mode (phantom grant → guided tccutil reset):

```ts
export type MicHealth = 'ok' | 'needsPermission' | 'silent' | 'phantomGrant';

/** Zeros DIGITAIS puros (rms === 0) sustentados por isto = grant TCC fantasma:
 *  o macOS diz 'granted' mas entrega silêncio absoluto (WAKE-BROKEN-001).
 *  Sala quieta tem ruído de fundo pequeno mas > 0 — nunca zero exato. */
export const PHANTOM_ZERO_MS = 10_000;

export function classifyMicHealth(
  permission: MicPermissionState,
  silentMs: number,
  silentThresholdMs: number,
  zero?: { zeroMs: number; zeroThresholdMs?: number },
): MicHealth {
  if (permission === 'denied' || permission === 'prompt') return 'needsPermission';
  if (
    permission === 'granted' &&
    zero !== undefined &&
    zero.zeroMs >= (zero.zeroThresholdMs ?? PHANTOM_ZERO_MS)
  ) {
    return 'phantomGrant';
  }
  if (permission === 'granted' && silentMs >= silentThresholdMs) return 'silent';
  return 'ok';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/voice/wake-health.test.ts`
Expected: PASS (old + 5 new tests).

- [ ] **Step 5: Track zeros in wake-mic.ts**

In `src/renderer/voice/wake-mic.ts`:

1. Add a private field next to the existing `silentSince` declaration (grep `silentSince = 0`):

```ts
  private zeroSince = 0;
```

2. In `onFrame` (~L401-437) replace:

```ts
      const level = rmsToLevel(frameRms(frame));
      this.onLevel?.(level);
      // Saúde do mic: acumula quanto tempo em silêncio (RMS abaixo do piso).
      const silent = frameIsSilent(frameRms(frame));
```

with:

```ts
      const rms = frameRms(frame);
      const level = rmsToLevel(rms);
      this.onLevel?.(level);
      // Saúde do mic: acumula quanto tempo em silêncio (RMS abaixo do piso).
      const silent = frameIsSilent(rms);
      // TCC fantasma: zeros DIGITAIS puros (rms === 0), distintos de sala quieta.
      this.zeroSince = rms === 0 ? this.zeroSince || Date.now() : 0;
```

3. Add the getter mirroring `getSilentMs()` (L143):

```ts
  /** Há quanto tempo os frames são ZERO digital puro (0 = já ouviu sinal). */
  getZeroMs(): number {
    return this.zeroSince ? Date.now() - this.zeroSince : 0;
  }
```

4. Reset `this.zeroSince = 0;` at every site where `this.silentSince = 0` is reset on stream (re)open/stop (grep `silentSince = 0` and mirror each site).

- [ ] **Step 6: Wire classification in voice-controller.ts**

At L328, replace:

```ts
      const health = classifyMicHealth(perm, wakeMic.getSilentMs(), MIC_SILENT_THRESHOLD_MS);
```

with:

```ts
      const health = classifyMicHealth(perm, wakeMic.getSilentMs(), MIC_SILENT_THRESHOLD_MS, {
        zeroMs: wakeMic.getZeroMs(),
      });
```

- [ ] **Step 7: Shared channel + API type + preload + main handler**

1. `src/shared/voice-channels.ts` — add alongside `openMicSettings` (L27):

```ts
  micResetTcc: 'voice:micResetTcc',
```

2. `src/shared/voice-ipc.ts` — find the `confirmCommand` method declaration in the voice API type and add a sibling:

```ts
  /** macOS: tccutil reset Microphone <bundleId> + relaunch (grant TCC fantasma). */
  resetMicPermission: () => Promise<{ ok: boolean; error?: string }>;
```

3. `src/preload/preload.ts` — next to `openMicSettings` (L377):

```ts
    resetMicPermission: () => ipcRenderer.invoke(VOICE_CHANNELS.micResetTcc),
```

4. Create `src/main/voice/mic-tcc.ts`:

```ts
/**
 * Recuperação do grant TCC fantasma (WAKE-BROKEN-001 Rank 1): macOS diz
 * 'granted' mas entrega PCM zerado. Fix documentado: tccutil reset Microphone
 * <bundleId> + relançar + clicar Permitir. Helpers puros/finos, testáveis.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Extrai o caminho do bundle .app do execPath (null fora de um .app). */
export function appBundlePathFromExecPath(execPath: string): string | null {
  const m = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1] : null;
}

/** Lê o CFBundleIdentifier do Info.plist do bundle (macOS). */
export async function readBundleId(appBundlePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('defaults', [
      'read',
      `${appBundlePath}/Contents/Info`,
      'CFBundleIdentifier',
    ]);
    const id = stdout.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Reseta a entrada TCC de microfone do próprio bundle. Lança em falha. */
export async function resetMicrophoneTcc(bundleId: string): Promise<void> {
  await execFileP('tccutil', ['reset', 'Microphone', bundleId]);
}
```

5. Create `src/main/voice/mic-tcc.test.ts` (write BEFORE mic-tcc.ts if following strict TDD order):

```ts
import { describe, expect, it } from 'vitest';
import { appBundlePathFromExecPath } from './mic-tcc';

describe('appBundlePathFromExecPath', () => {
  it('extrai o bundle de um app empacotado', () => {
    expect(
      appBundlePathFromExecPath('/Applications/Nexus.app/Contents/MacOS/Nexus'),
    ).toBe('/Applications/Nexus.app');
  });

  it('extrai o bundle do shell dev (.dev-electron)', () => {
    expect(
      appBundlePathFromExecPath(
        '/Users/x/dev/nexus-ide/.dev-electron/Electron.app/Contents/MacOS/Electron',
      ),
    ).toBe('/Users/x/dev/nexus-ide/.dev-electron/Electron.app');
  });

  it('null fora de um bundle .app', () => {
    expect(appBundlePathFromExecPath('/usr/local/bin/electron')).toBeNull();
  });
});
```

Run: `npx vitest run src/main/voice/mic-tcc.test.ts` — expect PASS.

6. `src/main/voice/voice-ipc.ts` — near the `openMicSettings` handler (L284), add (imports: `dialog`, `app` from `'electron'` — extend the existing electron import; helpers from `'./mic-tcc'`):

```ts
  ipcMain.handle(
    VOICE_CHANNELS.micResetTcc,
    async (): Promise<{ ok: boolean; error?: string }> => {
      if (process.platform !== 'darwin') return { ok: false, error: 'só macOS' };
      const appPath = appBundlePathFromExecPath(process.execPath);
      const bundleId = appPath ? await readBundleId(appPath) : null;
      if (!bundleId) {
        return {
          ok: false,
          error: 'bundle id não resolvido — rode: tccutil reset Microphone <seu-bundle-id>',
        };
      }
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Resetar e reiniciar', 'Cancelar'],
        defaultId: 0,
        cancelId: 1,
        message: 'Resetar a permissão de microfone?',
        detail: `Vou rodar "tccutil reset Microphone ${bundleId}" e reiniciar o app. Na volta, clique Permitir quando o macOS pedir o microfone.`,
      });
      if (response !== 0) return { ok: false, error: 'cancelado' };
      try {
        await resetMicrophoneTcc(bundleId);
      } catch (err) {
        logVoice('warn', 'mic.tccResetFailed', 'tccutil falhou', { error: String(err) });
        return { ok: false, error: `tccutil falhou: ${String(err)}` };
      }
      logVoice('warn', 'mic.tccReset', 'TCC Microphone resetado — relançando', { bundleId });
      app.relaunch();
      app.exit(0);
      return { ok: true };
    },
  );
```

- [ ] **Step 8: HUD banner**

In `src/renderer/components/VoiceHud.tsx`, add BEFORE the `micHealth === 'silent'` block (L365) — `useVoiceStore` is already imported (powers the selector at L58):

```tsx
              {micHealth === 'phantomGrant' && (
                <span className="voice-hud__detail voice-hud__detail--error">
                  Permissão de mic fantasma — o macOS diz OK mas entrega silêncio.
                  <button
                    type="button"
                    className="voice-hud__action"
                    onClick={() => {
                      void window.nexus.voice.resetMicPermission().then((r) => {
                        if (!r.ok) {
                          useVoiceStore
                            .getState()
                            .setNote(`Reset falhou: ${r.error ?? 'erro desconhecido'}`);
                        }
                      });
                    }}
                  >
                    Resetar e reiniciar
                  </button>
                </span>
              )}
```

- [ ] **Step 9: Typecheck + full tests**

Run: `npm run typecheck && npx vitest run src/renderer/voice/wake-health.test.ts src/main/voice/mic-tcc.test.ts`
Expected: clean + PASS.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/voice/wake-health.ts src/renderer/voice/wake-health.test.ts src/renderer/voice/wake-mic.ts src/renderer/voice/voice-controller.ts src/renderer/components/VoiceHud.tsx src/main/voice/mic-tcc.ts src/main/voice/mic-tcc.test.ts src/shared/voice-channels.ts src/shared/voice-ipc.ts src/preload/preload.ts src/main/voice/voice-ipc.ts
git commit -m "fix(voice): detect phantom TCC mic grant (rms:0 while granted) + one-click guided tccutil reset"
```

---

**Continue in Part 2:** `docs/superpowers/plans/2026-07-09-jarvis-phase0-unblock-part2.md` (Task 4: send_to_pane voice-confirmation gate; Task 5: two-voices attribution observability; final verification checklist).
