// MOB-05 (F-1021): atividade dos panes para o app do celular.
//
// Nada é detectado aqui. As entradas são os MESMOS sinais que a UI do desktop
// já consome (ligados em remote-pane-activity-sources.ts):
//   - estado da sessão do PTY (`tapSessionState`/`tapSessionExit`, o canal
//     pty:stateChange do toolbar): spawning/busy → trabalhando, idle → parado,
//     exited → encerrado;
//   - os dois planos de "pede você" da caixa ⌘J (semântico `/hook/status` e
//     hooks Orca), com a mesma regra OU de shared/agent-waiting.ts.
// Daí sai UMA atividade por sessão: working | waiting | idle | exited.
//
// O push é agrupado e limitado POR SESSÃO: a mudança espera `coalesceMs` (o
// vai-e-volta busy↔idle vira um push só, com o estado final) e no máximo
// `maxPerWindow` pushes por `windowMs`; acima disso o estado final sai quando a
// janela abre — o último estado nunca se perde. O conteúdo da saída nunca entra
// aqui: só sessão, atividade e instante. A autoridade (quem pode ler qual pane)
// fica com a bridge, no `deliver`.
import type { PaneSessionState } from '../../shared/types';
import {
  hookStateNeedsHumanInput,
  type AgentWaitingSource,
} from '../../shared/agent-waiting';

export type RemotePaneActivity = 'working' | 'waiting' | 'idle' | 'exited';

export interface RemotePaneActivityEntry {
  readonly sessionId: string;
  readonly activity: RemotePaneActivity;
  /** Quando a sessão entrou nesta atividade (epoch ms do desktop). */
  readonly at: number;
}

export interface RemotePaneActivityLimits {
  readonly coalesceMs: number;
  readonly maxPerWindow: number;
  readonly windowMs: number;
}

export const REMOTE_PANE_ACTIVITY_LIMITS: RemotePaneActivityLimits = Object.freeze({
  coalesceMs: 1_500,
  maxPerWindow: 12,
  windowMs: 60_000,
});

/** Teto de sessões lembradas; a mais antiga sai primeiro. */
export const REMOTE_PANE_ACTIVITY_MAX_SESSIONS = 1_024;

export interface RemotePaneActivitySink {
  /** Há aparelho autenticado agora? Sem ninguém, só o estado é guardado. */
  readonly hasListeners: () => boolean;
  readonly deliver: (entry: RemotePaneActivityEntry) => void;
}

interface SessionRecord {
  pty: RemotePaneActivity | null;
  readonly waiting: Set<AgentWaitingSource>;
  activity: RemotePaneActivity | null;
  at: number;
  lastSent: RemotePaneActivity | null;
  sentAt: number[];
  timer: ReturnType<typeof setTimeout> | null;
}

export function activityForSessionState(state: PaneSessionState): RemotePaneActivity {
  switch (state) {
    case 'spawning':
    case 'busy':
      return 'working';
    case 'exited':
      return 'exited';
    default:
      return 'idle';
  }
}

function derive(record: SessionRecord): RemotePaneActivity | null {
  if (record.pty === 'exited') return 'exited';
  if (record.waiting.size > 0) return 'waiting';
  return record.pty;
}

export function createRemotePaneActivityFeed(deps: {
  readonly sink: () => RemotePaneActivitySink | null;
  readonly limits?: () => RemotePaneActivityLimits;
  readonly now?: () => number;
}) {
  const records = new Map<string, SessionRecord>();
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? (() => REMOTE_PANE_ACTIVITY_LIMITS);

  const recordFor = (sessionId: string): SessionRecord => {
    let record = records.get(sessionId);
    if (record) return record;
    if (records.size >= REMOTE_PANE_ACTIVITY_MAX_SESSIONS) {
      const oldest = records.keys().next().value;
      if (oldest !== undefined) drop(oldest);
    }
    record = {
      pty: null,
      waiting: new Set(),
      activity: null,
      at: 0,
      lastSent: null,
      sentAt: [],
      timer: null,
    };
    records.set(sessionId, record);
    return record;
  };

  const drop = (sessionId: string): void => {
    const record = records.get(sessionId);
    if (record?.timer) clearTimeout(record.timer);
    records.delete(sessionId);
  };

  const schedule = (sessionId: string, record: SessionRecord, delayMs: number): void => {
    if (record.timer) return;
    record.timer = setTimeout(() => flush(sessionId), Math.max(0, delayMs));
    record.timer.unref?.();
  };

  const flush = (sessionId: string): void => {
    const record = records.get(sessionId);
    if (!record) return;
    record.timer = null;
    if (record.activity === null || record.activity === record.lastSent) return;
    const sink = deps.sink();
    if (!sink?.hasListeners()) {
      // Ninguém ouvindo: quem conectar depois lê o estado por pane.activity.list.
      record.lastSent = record.activity;
      return;
    }
    const t = now();
    const { maxPerWindow, windowMs } = limits();
    record.sentAt = record.sentAt.filter((sentAt) => t - sentAt < windowMs);
    if (record.sentAt.length >= maxPerWindow) {
      schedule(sessionId, record, record.sentAt[0]! + windowMs - t);
      return;
    }
    record.sentAt.push(t);
    record.lastSent = record.activity;
    try {
      sink.deliver({ sessionId, activity: record.activity, at: record.at });
    } catch (err) {
      console.warn('[remote-pane-activity] deliver failed:', err);
    }
  };

  const update = (sessionId: string, mutate: (record: SessionRecord) => void): void => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) return;
    const record = recordFor(sessionId);
    mutate(record);
    const next = derive(record);
    if (next === null || next === record.activity) return;
    record.activity = next;
    record.at = now();
    if (!deps.sink()?.hasListeners()) {
      record.lastSent = next;
      return;
    }
    schedule(sessionId, record, limits().coalesceMs);
  };

  return {
    sessionState(sessionId: string, state: PaneSessionState): void {
      update(sessionId, (record) => {
        record.pty = activityForSessionState(state);
        if (record.pty === 'exited') record.waiting.clear();
      });
    },
    sessionExit(sessionId: string): void {
      update(sessionId, (record) => {
        record.pty = 'exited';
        record.waiting.clear();
      });
    },
    /** Um plano de hook (semântico ou Orca) disse o estado da sessão. */
    waiting(sessionId: string, source: AgentWaitingSource, state: string): void {
      update(sessionId, (record) => {
        if (hookStateNeedsHumanInput(state)) record.waiting.add(source);
        else record.waiting.delete(source);
      });
    },
    list(): RemotePaneActivityEntry[] {
      const out: RemotePaneActivityEntry[] = [];
      for (const [sessionId, record] of records) {
        if (record.activity) out.push({ sessionId, activity: record.activity, at: record.at });
      }
      return out;
    },
    clear(): void {
      for (const sessionId of [...records.keys()]) drop(sessionId);
    },
  };
}

export type RemotePaneActivityFeed = ReturnType<typeof createRemotePaneActivityFeed>;

let sink: RemotePaneActivitySink | null = null;
let limitsOverride: RemotePaneActivityLimits | null = null;

/** O feed do processo: as fontes escrevem aqui, a Remote Bridge é o sink. */
export const remotePaneActivity = createRemotePaneActivityFeed({
  sink: () => sink,
  limits: () => limitsOverride ?? REMOTE_PANE_ACTIVITY_LIMITS,
});

export function registerRemotePaneActivitySink(next: RemotePaneActivitySink): void {
  sink = next;
}

/** Só para testes: janelas curtas para provar agrupamento e limite. */
export function __setRemotePaneActivityLimitsForTests(next: RemotePaneActivityLimits | null): void {
  limitsOverride = next;
}
