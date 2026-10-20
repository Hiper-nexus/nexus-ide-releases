import { decisionResultUsage } from '../decision-models/decision-usage';
import type { DecisionProvider } from '../../shared/decision-models';
/**
 * Classificador Jev do estado do pane (piloto automático, superfície
 * `paneState`). Os manifests do `AgentScreenDetector` resolvem os CLIs
 * conhecidos de forma determinística; o Jev é o fallback para o que o
 * manifesto não consegue ler (`state === 'unknown'` ou `idle` com
 * `fallbackReason`). UMA chamada `judge()` por classificação, com debounce,
 * intervalo mínimo e dedupe por hash do texto — fail-open em tudo: erro,
 * timeout ou toggle desligado deixam o estado semântico exatamente como está.
 * NUNCA muda a lógica de parking/reaper do guardian.
 */
import { createHash } from 'node:crypto';
import {
  judge,
  type JevQuestion,
} from './jev-client';
import { isJevSurfaceEnabled } from './jev-autopilot';
import { hasDecisionCredential, decisionConfigurationKey } from '../decision-models/decision-availability';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
  recordJevOptimization,
} from './jev-decision-log';
import { JEV_CHANNELS } from '../../shared/jev-channels';
import { VOICE_CHANNELS } from '../../shared/voice-channels';
import {
  activeScreenText,
  tapActiveScreenDetections,
  type ScreenDetectionTap,
} from '../detect/detector';
import { tapSessionExit } from '../pty/pty-manager';

const DEBOUNCE_MS = 15_000;
const MIN_CALL_INTERVAL_MS = 60_000;
const NARRATE_INTERVAL_MS = 10 * 60_000;
const CLASSIFY_TIMEOUT_MS = 6_000;
const NEEDS_HUMAN_NARRATE_MIN = 0.75;

export const JEV_PANE_STATES = [
  'working',
  'waiting_for_human',
  'finished',
  'errored',
  'idle_prompt',
] as const;

export type JevPaneStateKind = (typeof JEV_PANE_STATES)[number];

export interface JevPaneHint {
  state: JevPaneStateKind;
  confidence: number;
  needsHuman: number;
  at: number;
  model: string;
  /** Quem respondeu esta classificação (rota do judge); ausente = Jev. */
  provider?: DecisionProvider;
}

const PANE_STATE_QUESTIONS: Record<string, JevQuestion> = {
  state: {
    type: 'choice',
    instructions:
      'The text is a screenshot of an AI coding agent terminal. What is the agent doing right now?',
    criteria: {
      working: 'the agent is actively producing output or running a tool',
      waiting_for_human:
        'the agent stopped and is waiting for the user: a question, a permission/approval prompt, a menu or a request for input',
      finished:
        'the agent completed its task and sits idle at its prompt after a final summary',
      errored: 'the agent or CLI crashed, exited or shows a fatal error',
      idle_prompt:
        'an idle prompt with no pending question and no summary',
    },
  },
  needs_human: {
    type: 'noul',
    instructions:
      'Does resolving what is on screen require a human action (answer, approval, decision) rather than waiting or an automatic retry?',
  },
};

const hints = new Map<string, JevPaneHint>();

export function getJevPaneHint(sessionId: string): JevPaneHint | null {
  return hints.get(sessionId) ?? null;
}

/**
 * Classificação sob demanda para o digest do `nexus_pane_read` — reusa as
 * mesmas perguntas/superfície do classificador contínuo, mas responde na hora
 * (timeout curto) e cacheia por hash do texto (60 s) para uma rajada de
 * pane_read não virar uma rajada de chamadas. Fail-open: sem credencial,
 * surface off, timeout ou resposta inválida devolvem `null` — o digest sai
 * sem os campos de estado.
 */
const DIGEST_CLASSIFY_TIMEOUT_MS = 4_000;
const DIGEST_CACHE_TTL_MS = 60_000;
/** A missing/invalid answer is remembered only briefly: long enough to survive an outage burst, short enough to recover. */
const DIGEST_NEGATIVE_CACHE_TTL_MS = 20_000;
const DIGEST_MAX_CHARS = 3_000;
const DIGEST_CACHE_CAP = 256;

export interface PaneTailClassification {
  readonly state: JevPaneStateKind;
  readonly confidence: number;
  readonly needsHuman: number;
}

export interface PaneTailClassifyDeps {
  readonly configurationKey?: () => string;
  readonly judge?: typeof judge;
  readonly enabled?: () => boolean;
  readonly hasKey?: () => boolean;
  readonly now?: () => number;
  /** Missão de quem lê o digest (o Maestro): a consulta conta no orçamento dela (F-1164). */
  readonly missionId?: string;
}

/** `result: null` is a remembered failure (outage, malformed answer), keyed like any other by configuration. */
const digestClassifyCache = new Map<
  string,
  { at: number; result: PaneTailClassification | null; model: string | null }
>();

export async function classifyPaneTailForDigest(
  text: string,
  deps: PaneTailClassifyDeps = {},
): Promise<PaneTailClassification | null> {
  const now = deps.now ?? Date.now;
  const clipped = text.slice(-DIGEST_MAX_CHARS);
  try {
    const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('paneState'));
    const hasKey = deps.hasKey ?? (() => hasDecisionCredential('paneState'));
    if (!enabled() || !hasKey()) return null;
    const configuration = deps.configurationKey ?? decisionConfigurationKey;
    const before = configuration();
    const hash = createHash('sha256').update(before).update(clipped).digest('hex');
    const cached = digestClassifyCache.get(hash);
    if (cached && now() - cached.at < (cached.result ? DIGEST_CACHE_TTL_MS : DIGEST_NEGATIVE_CACHE_TTL_MS)) {
      if (cached.result && cached.model) recordJevOptimization({ surface: 'paneState', missionId: deps.missionId, model: cached.model, optimization: { jevRequestsAvoided: 1 } });
      return cached.result;
    }
    const judgeFn = deps.judge ?? judge;
    let noAnswerReason: string | undefined;
    const result = await judgeFn({
      state: { screen: clipped },
      questions: PANE_STATE_QUESTIONS,
      timeoutMs: DIGEST_CLASSIFY_TIMEOUT_MS,
      surface: 'paneState',
      missionId: deps.missionId,
      onNoAnswer: (reason) => { noAnswerReason = reason; },
    });
    // F-1164: recusa por orçamento é da missão de quem leu, não do texto —
    // lembrada como falha, calaria o digest das outras missões pelo mesmo texto.
    if (!result && noAnswerReason === 'budget') return null;
    if (configuration() !== before || !enabled() || !hasKey()) return null;
    let classified: PaneTailClassification | null = null;
    const stateAnswer = result?.answers.state;
    if (
      result &&
      stateAnswer?.type === 'choice' &&
      JEV_PANE_STATES.includes(stateAnswer.choice as JevPaneStateKind)
    ) {
      const needsAnswer = result.answers.needs_human;
      classified = {
        state: stateAnswer.choice as JevPaneStateKind,
        confidence:
          typeof stateAnswer.confidence === 'number'
            ? stateAnswer.confidence
            : 0,
        needsHuman: needsAnswer?.type === 'noul' ? needsAnswer.noul : 0,
      };
      recordJevDecision({
        surface: 'paneState',
        missionId: deps.missionId,
        model: result.model,
        questions: Object.keys(PANE_STATE_QUESTIONS),
        probabilities: jevAnswerProbabilities(result.answers),
        confidence: jevAnswerConfidences(result.answers),
        decision: `digest-state:${classified.state}`,
        ...decisionResultUsage(result),
      });
    }
    if (digestClassifyCache.size >= DIGEST_CACHE_CAP) {
      const oldest = digestClassifyCache.keys().next().value;
      if (oldest !== undefined) digestClassifyCache.delete(oldest);
    }
    digestClassifyCache.set(hash, { at: now(), result: classified, model: result?.model ?? null });
    return classified;
  } catch {
    // Fail-open: digest sem estado vale mais que digest nenhum.
    return null;
  }
}

function broadcastPaneHint(payload: {
  sessionId: string;
  paneId?: string;
  hint: JevPaneHint;
}): void {
  try {
    // Lazy electron import keeps unit tests free of app bootstrap.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BrowserWindow } = require('electron') as typeof import('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents;
      if (wc.isDestroyed() || wc.isCrashed()) continue;
      wc.send(JEV_CHANNELS.paneHint, payload);
    }
  } catch {
    // Sem janelas/Electron (testes): o hint segue consultável via getJevPaneHint.
  }
}

function defaultPaneLabel(sessionId: string, paneId?: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- pane-registry arrasta ~600 módulos do orquestrador e o Electron; tardio, o classificador segue testável e o catch cobre a ausência
    const { listPaneSnapshots } =
      require('../orch/pane-registry') as typeof import('../orch/pane-registry');
    const snap = listPaneSnapshots().find(
      (p) => p.sessionId === sessionId || p.paneId === paneId,
    );
    if (!snap) return null;
    return (
      snap.title ||
      snap.adapterId ||
      (snap.paneNumber !== undefined ? `pane ${snap.paneNumber}` : null)
    );
  } catch {
    return null;
  }
}

function defaultMissionOf(sessionId: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- mesmo motivo do defaultPaneLabel: pane-registry é pesado e ausente nos testes
    const { getPaneAuthzInfo } =
      require('../orch/pane-registry') as typeof import('../orch/pane-registry');
    return getPaneAuthzInfo(sessionId)?.missionId || undefined;
  } catch {
    return undefined;
  }
}

function defaultNarrate(text: string, paneId?: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- Electron só existe no app; nos testes o require cai no catch
    const { BrowserWindow } = require('electron') as typeof import('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents;
      if (wc.isDestroyed() || wc.isCrashed()) continue;
      wc.send(VOICE_CHANNELS.narrate, {
        text,
        eventId: `jev-pane-${paneId ?? 'unknown'}`,
        ...(paneId ? { paneId } : {}),
      });
    }
  } catch {
    // Sem Electron: nada a narrar.
  }
}

export interface JevPaneStateDeps {
  tapDetections?: (cb: ScreenDetectionTap) => (() => void) | null;
  tapExit?: (cb: (sessionId: string) => void) => () => void;
  screenText?: (sessionId: string) => string | null;
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
  now?: () => number;
  broadcast?: (payload: {
    sessionId: string;
    paneId?: string;
    hint: JevPaneHint;
  }) => void;
  narrate?: (text: string, paneId?: string) => void;
  paneLabel?: (sessionId: string, paneId?: string) => string | null;
  /** Missão do pane classificado (F-1164); padrão = registro de panes. */
  missionOf?: (sessionId: string) => string | undefined;
}

interface SessionTrack {
  timer: ReturnType<typeof setTimeout> | null;
  lastHash: string | null;
  lastCallAt: number;
  lastNarrateAt: number;
}

/**
 * Instala o tap no detector ativo e devolve o disposer. Retorna no-op quando a
 * detecção de tela não está rodando (manifest load falhou, testes sem pty).
 */
export function startJevPaneStateClassifier(
  deps: JevPaneStateDeps = {},
): () => void {
  const tapDetections = deps.tapDetections ?? tapActiveScreenDetections;
  const untap = tapDetections(onRecord);
  if (!untap) return () => {};
  const tapExit = deps.tapExit ?? tapSessionExit;
  const untapExit = tapExit((sessionId) => clearSession(sessionId));
  const tracks = new Map<string, SessionTrack>();
  const now = deps.now ?? Date.now;

  function trackOf(sessionId: string): SessionTrack {
    let t = tracks.get(sessionId);
    if (!t) {
      t = { timer: null, lastHash: null, lastCallAt: 0, lastNarrateAt: 0 };
      tracks.set(sessionId, t);
    }
    return t;
  }

  function clearSession(sessionId: string): void {
    const t = tracks.get(sessionId);
    if (t?.timer) clearTimeout(t.timer);
    tracks.delete(sessionId);
    hints.delete(sessionId);
  }

  function onRecord(record: Parameters<ScreenDetectionTap>[0]): void {
    // Só dispara no que o manifesto NÃO resolveu: desconhecido, ou idle
    // inferido por fallback (não por regra).
    if (
      !(
        record.state === 'unknown' ||
        (record.state === 'idle' && record.fallbackReason !== null)
      )
    ) {
      return;
    }
    const t = trackOf(record.sessionId);
    if (t.timer) clearTimeout(t.timer);
    const sessionId = record.sessionId;
    const paneId = record.paneId;
    t.timer = setTimeout(() => {
      t.timer = null;
      void classify(sessionId, paneId);
    }, DEBOUNCE_MS);
    t.timer.unref?.();
  }

  async function classify(sessionId: string, paneId?: string): Promise<void> {
    const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('paneState'));
    const hasKey = deps.hasKey ?? (() => hasDecisionCredential('paneState'));
    if (!enabled() || !hasKey()) return;
    const screenText = deps.screenText ?? activeScreenText;
    const text = screenText(sessionId);
    if (!text || !text.trim()) return;
    const t = trackOf(sessionId);
    const hash = createHash('sha256').update(text).digest('hex');
    if (hash === t.lastHash) return;
    if (now() - t.lastCallAt < MIN_CALL_INTERVAL_MS) return;
    // Marca antes do await: duas classificações concorrentes nunca saem.
    t.lastHash = hash;
    t.lastCallAt = now();
    try {
      const judgeFn = deps.judge ?? judge;
      const missionId = (deps.missionOf ?? defaultMissionOf)(sessionId);
      const result = await judgeFn({
        state: { screen: text },
        questions: PANE_STATE_QUESTIONS,
        timeoutMs: CLASSIFY_TIMEOUT_MS,
        surface: 'paneState',
        sessionId,
        missionId,
      });
      if (!result) return;
      const stateAnswer = result.answers.state;
      if (
        stateAnswer?.type !== 'choice' ||
        !JEV_PANE_STATES.includes(stateAnswer.choice as JevPaneStateKind)
      ) {
        return;
      }
      const needsAnswer = result.answers.needs_human;
      const usage = decisionResultUsage(result);
      const hint: JevPaneHint = {
        state: stateAnswer.choice as JevPaneStateKind,
        confidence:
          typeof stateAnswer.confidence === 'number'
            ? stateAnswer.confidence
            : 0,
        needsHuman: needsAnswer?.type === 'noul' ? needsAnswer.noul : 0,
        at: now(),
        model: result.model,
        provider: usage.provider,
      };
      hints.set(sessionId, hint);
      recordJevDecision({
        surface: 'paneState',
        sessionId,
        missionId,
        model: result.model,
        questions: Object.keys(PANE_STATE_QUESTIONS),
        probabilities: jevAnswerProbabilities(result.answers),
        confidence: jevAnswerConfidences(result.answers),
        decision: `state:${hint.state}`,
        ...usage,
      });
      (deps.broadcast ?? broadcastPaneHint)({ sessionId, paneId, hint });
      if (
        hint.state === 'waiting_for_human' &&
        hint.needsHuman >= NEEDS_HUMAN_NARRATE_MIN &&
        now() - t.lastNarrateAt >= NARRATE_INTERVAL_MS
      ) {
        t.lastNarrateAt = now();
        try {
          const label =
            (deps.paneLabel ?? defaultPaneLabel)(sessionId, paneId) ?? paneId;
          (deps.narrate ?? defaultNarrate)(
            `O pane ${label ?? 'do agente'} precisa de você.`,
            paneId,
          );
        } catch {
          // Narração é best-effort: nunca derruba a classificação.
        }
      }
    } catch {
      // Fail-open: qualquer erro do Jev/fs deixa o estado semântico intacto.
    }
  }

  return () => {
    untap();
    untapExit();
    for (const t of tracks.values()) {
      if (t.timer) clearTimeout(t.timer);
    }
    tracks.clear();
    hints.clear();
  };
}
