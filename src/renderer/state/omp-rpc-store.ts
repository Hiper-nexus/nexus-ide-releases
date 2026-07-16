import { create } from 'zustand';
import {
  ompRpcEventEnvelopeSchema,
  type OmpApprovalPolicy,
  type OmpRpcModelInfo,
  type OmpRpcPushEvent,
  type OmpRpcStateSnapshot,
  type OmpRpcUiResponse,
} from '../../shared/omp-rpc-types';
import { getActiveWorkspacePath } from './active-workspace';

/**
 * Espelho renderer de UMA sessão omp rpc-ui hospedada no main (B1: painel
 * mínimo funcional, uma sessão por vez). Todos os eventos push chegam pelo
 * preload e são revalidados com zod AQUI — o renderer nunca confia no frame
 * sem parse (mesma doutrina do main).
 */

export type OmpTranscriptEntry =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string; open: boolean }
  | { id: number; kind: 'thinking'; text: string; open: boolean }
  | {
      id: number;
      kind: 'tool';
      toolCallId: string;
      name: string;
      argsPreview: string;
      status: 'running' | 'ok' | 'error';
    }
  | { id: number; kind: 'notice'; level: 'info' | 'warning' | 'error'; text: string };

export interface OmpPendingUiRequest {
  requestId: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  message: string | null;
  options: string[] | null;
  placeholder: string | null;
}

interface OmpRpcUiState {
  panelOpen: boolean;
  sessionId: string | null;
  starting: boolean;
  startError: string | null;
  snapshot: OmpRpcStateSnapshot | null;
  approvalPolicy: OmpApprovalPolicy;
  transcript: OmpTranscriptEntry[];
  models: OmpRpcModelInfo[];
  pendingUi: OmpPendingUiRequest[];

  togglePanel(): void;
  setApprovalPolicy(policy: OmpApprovalPolicy): void;
  start(): Promise<void>;
  sendPrompt(message: string, behavior?: 'steer' | 'followUp'): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  respondUi(requestId: string, response: OmpRpcUiResponse): Promise<void>;
  disposeSession(): Promise<void>;
}

let entrySeq = 0;
const nextId = () => ++entrySeq;
let subscribed = false;

/** Garante a assinatura única do canal de eventos push. */
function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  window.nexus.ompRpc.onEvent((raw) => {
    const parsed = ompRpcEventEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return; // evento fora do contrato: descarta
    const { sessionId, event } = parsed.data;
    const state = useOmpRpcStore.getState();
    if (state.sessionId !== sessionId) return;
    applyEvent(event);
  });
}

function appendDelta(
  transcript: OmpTranscriptEntry[],
  kind: 'assistant' | 'thinking',
  delta: string,
): OmpTranscriptEntry[] {
  const last = transcript[transcript.length - 1];
  if (last && last.kind === kind && last.open) {
    const updated = { ...last, text: last.text + delta };
    return [...transcript.slice(0, -1), updated];
  }
  return [...transcript, { id: nextId(), kind, text: delta, open: true }];
}

function closeOpenEntries(transcript: OmpTranscriptEntry[]): OmpTranscriptEntry[] {
  return transcript.map((entry) =>
    (entry.kind === 'assistant' || entry.kind === 'thinking') && entry.open
      ? { ...entry, open: false }
      : entry,
  );
}

function settleTool(
  transcript: OmpTranscriptEntry[],
  toolCallId: string,
  status: 'ok' | 'error',
): OmpTranscriptEntry[] {
  return transcript.map((entry) =>
    entry.kind === 'tool' && entry.toolCallId === toolCallId
      ? { ...entry, status }
      : entry,
  );
}

function applyEvent(event: OmpRpcPushEvent): void {
  const set = useOmpRpcStore.setState;
  const get = useOmpRpcStore.getState;
  switch (event.kind) {
    case 'status':
      set({
        snapshot: {
          state: event.state,
          model: event.model,
          contextUsage: event.contextUsage,
          isStreaming: event.isStreaming,
          sessionName: event.sessionName,
          approvalPolicy: get().approvalPolicy,
          autoApprovals: event.autoApprovals,
        },
      });
      return;
    case 'text-delta':
      set({ transcript: appendDelta(get().transcript, 'assistant', event.delta) });
      return;
    case 'thinking-delta':
      set({ transcript: appendDelta(get().transcript, 'thinking', event.delta) });
      return;
    case 'message-end':
      set({ transcript: closeOpenEntries(get().transcript) });
      return;
    case 'tool': {
      if (event.status === 'running') {
        set({
          transcript: [
            ...get().transcript,
            {
              id: nextId(),
              kind: 'tool',
              toolCallId: event.toolCallId,
              name: event.name,
              argsPreview: event.argsPreview,
              status: 'running',
            },
          ],
        });
      } else {
        set({
          transcript: settleTool(get().transcript, event.toolCallId, event.status),
        });
      }
      return;
    }
    case 'ui-request':
      set({
        pendingUi: [
          ...get().pendingUi,
          {
            requestId: event.requestId,
            method: event.method,
            title: event.title,
            message: event.message,
            options: event.options,
            placeholder: event.placeholder,
          },
        ],
      });
      return;
    case 'ui-request-settled':
      set({
        pendingUi: get().pendingUi.filter(
          (request) => request.requestId !== event.requestId,
        ),
      });
      return;
    case 'auto-approval':
      set({
        transcript: [
          ...get().transcript,
          {
            id: nextId(),
            kind: 'notice',
            level: 'info',
            text: `auto-aprovação (${event.decision}): ${event.title}`,
          },
        ],
      });
      return;
    case 'notice':
      set({
        transcript: [
          ...get().transcript,
          { id: nextId(), kind: 'notice', level: event.level, text: event.message },
        ],
      });
      return;
    case 'exit':
      set({
        sessionId: null,
        pendingUi: [],
        snapshot: get().snapshot
          ? { ...get().snapshot!, state: 'exited', isStreaming: false }
          : null,
        transcript: [
          ...closeOpenEntries(get().transcript),
          {
            id: nextId(),
            kind: 'notice',
            level: 'info',
            text: `sessão encerrada (código ${event.code ?? '—'})`,
          },
        ],
      });
      return;
    default:
      return;
  }
}

export const useOmpRpcStore = create<OmpRpcUiState>((set, get) => ({
  panelOpen: false,
  sessionId: null,
  starting: false,
  startError: null,
  snapshot: null,
  approvalPolicy: 'safe',
  transcript: [],
  models: [],
  pendingUi: [],

  togglePanel() {
    set((state) => ({ panelOpen: !state.panelOpen }));
  },

  setApprovalPolicy(policy) {
    if (get().sessionId) return; // política é por sessão, fixa no start
    set({ approvalPolicy: policy });
  },

  async start() {
    if (get().sessionId || get().starting) return;
    ensureSubscription();
    set({ starting: true, startError: null, transcript: [], pendingUi: [] });
    const workspaceRoot = getActiveWorkspacePath() ?? undefined;
    const result = await window.nexus.ompRpc.start({
      workspaceRoot,
      approvalPolicy: get().approvalPolicy,
    });
    if (!result.ok || !result.sessionId) {
      set({
        starting: false,
        startError: result.error ?? 'falha ao iniciar a sessão omp',
      });
      return;
    }
    set({ starting: false, sessionId: result.sessionId });
    const models = await window.nexus.ompRpc.listModels(result.sessionId);
    if (models.ok && get().sessionId === result.sessionId) {
      set({ models: models.models });
    }
  },

  async sendPrompt(message, behavior) {
    const sessionId = get().sessionId;
    if (!sessionId || !message.trim()) return;
    set({
      transcript: [
        ...closeOpenEntries(get().transcript),
        { id: nextId(), kind: 'user', text: message },
      ],
    });
    const result = await window.nexus.ompRpc.prompt(sessionId, message, behavior);
    if (!result.ok) {
      set({
        transcript: [
          ...get().transcript,
          {
            id: nextId(),
            kind: 'notice',
            level: 'error',
            text: result.error ?? 'prompt falhou',
          },
        ],
      });
    }
  },

  async abort() {
    const sessionId = get().sessionId;
    if (sessionId) await window.nexus.ompRpc.abort(sessionId);
  },

  async setModel(provider, modelId) {
    const sessionId = get().sessionId;
    if (sessionId) await window.nexus.ompRpc.setModel(sessionId, provider, modelId);
  },

  async respondUi(requestId, response) {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    await window.nexus.ompRpc.respondUi(sessionId, requestId, response);
    set({
      pendingUi: get().pendingUi.filter((request) => request.requestId !== requestId),
    });
  },

  async disposeSession() {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    await window.nexus.ompRpc.dispose(sessionId);
    set({ sessionId: null, pendingUi: [] });
  },
}));
