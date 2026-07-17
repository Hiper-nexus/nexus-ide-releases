import { create } from 'zustand';
import {
  ompRpcEventEnvelopeSchema,
  type OmpApprovalPolicy,
  type OmpRpcModelInfo,
  type OmpRpcPushEvent,
  type OmpRpcStateSnapshot,
  type OmpRpcUiResponse,
} from '../../shared/omp-rpc-types';
import {
  ompAuthEventEnvelopeSchema,
  type OmpAuthProviderInfo,
  type OmpAuthPushEvent,
} from '../../shared/omp-auth-types';
import { getActiveWorkspacePath } from './active-workspace';
import { claimRightDrawer, registerRightDrawer } from './right-drawer';
import { useToastStore } from './toast-store';

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
  | { id: number; kind: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { id: number; kind: 'open-url'; url: string };

export interface OmpPendingUiRequest {
  requestId: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  message: string | null;
  options: string[] | null;
  placeholder: string | null;
}

/** Fluxo de login OAuth em andamento (auth-broker), dirigido pelo painel. */
export interface OmpLoginFlowState {
  providerId: string;
  phase: 'awaiting-auth' | 'done' | 'error';
  url?: string;
  error?: string;
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
  authProviders: OmpAuthProviderInfo[];
  authProvidersLoading: boolean;
  /** Erro da última listagem de contas (inline na seção, sem toast). */
  authProvidersError: string | null;
  loginFlow: OmpLoginFlowState | null;

  togglePanel(): void;
  setApprovalPolicy(policy: OmpApprovalPolicy): void;
  start(): Promise<void>;
  refreshModels(): Promise<void>;
  sendPrompt(message: string, behavior?: 'steer' | 'followUp'): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  respondUi(requestId: string, response: OmpRpcUiResponse): Promise<void>;
  disposeSession(): Promise<void>;
  loadAuthProviders(): Promise<void>;
  startProviderLogin(providerId: string): Promise<void>;
  cancelProviderLogin(): Promise<void>;
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

let authSubscribed = false;
/** flowId do login em andamento (null até o invoke de login resolver). */
let activeAuthFlowId: string | null = null;
/** Cancelamento voluntário: o 'error' resultante não vira toast vermelho. */
let suppressAuthErrorToast = false;

/** Garante a assinatura única do canal de eventos do auth-broker. */
function ensureAuthSubscription(): void {
  if (authSubscribed) return;
  authSubscribed = true;
  window.nexus.ompAuth.onEvent((raw) => {
    const parsed = ompAuthEventEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return; // evento fora do contrato: descarta
    applyAuthEvent(parsed.data.flowId, parsed.data.event);
  });
}

function applyAuthEvent(flowId: string, event: OmpAuthPushEvent): void {
  const set = useOmpRpcStore.setState;
  const get = useOmpRpcStore.getState;
  if (activeAuthFlowId && activeAuthFlowId !== flowId) return;
  const flow = get().loginFlow;
  if (flow && flow.providerId !== event.providerId) return;
  switch (event.phase) {
    case 'awaiting-auth': {
      if (!flow) return;
      set({ loginFlow: { ...flow, phase: 'awaiting-auth', url: event.url } });
      return;
    }
    case 'done': {
      activeAuthFlowId = null;
      set({ loginFlow: null });
      const name =
        get().authProviders.find((p) => p.id === event.providerId)?.name ??
        event.providerId;
      useToastStore.getState().push('success', `Conta conectada: ${name}`);
      // Sonda + modelos mudam com a credencial nova — o dropdown atualiza
      // sem reiniciar a sessão.
      void get().loadAuthProviders();
      if (get().sessionId) void get().refreshModels();
      return;
    }
    case 'error': {
      activeAuthFlowId = null;
      const cancelled = suppressAuthErrorToast;
      suppressAuthErrorToast = false;
      set({ loginFlow: null });
      if (!cancelled) {
        useToastStore
          .getState()
          .push('error', 'Login não concluído', event.message);
      }
      return;
    }
    default:
      return;
  }
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
    case 'notice': {
      // Morte por falta de auth/modelo vira estado acionável (CTA de login no
      // painel) em vez de uma linha perdida no transcript.
      const isLoginNeeded =
        event.level === 'error' &&
        /No models available|\/login|API key/i.test(event.message);
      set({
        ...(isLoginNeeded
          ? {
              startError:
                'omp sem login/modelo — conecte uma conta na seção Contas abaixo (ou rode /login no omp do terminal) e inicie a sessão de novo.',
            }
          : {}),
        transcript: [
          ...get().transcript,
          { id: nextId(), kind: 'notice', level: event.level, text: event.message },
        ],
      });
      return;
    }
    case 'open-url':
      set({
        transcript: [
          ...get().transcript,
          { id: nextId(), kind: 'open-url', url: event.url },
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
  authProviders: [],
  authProvidersLoading: false,
  authProvidersError: null,
  loginFlow: null,

  togglePanel() {
    const panelOpen = !get().panelOpen;
    // Opening this drawer claims the shared right slot, closing the orch panel.
    if (panelOpen) claimRightDrawer('omp');
    set({ panelOpen });
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
    await get().refreshModels();
  },

  async refreshModels() {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    const result = await window.nexus.ompRpc.listModels(sessionId);
    if (result.ok && get().sessionId === sessionId) {
      set({ models: result.models });
    }
  },

  async loadAuthProviders() {
    if (get().authProvidersLoading) return;
    ensureAuthSubscription();
    set({ authProvidersLoading: true, authProvidersError: null });
    try {
      const result = await window.nexus.ompAuth.listProviders();
      if (result.ok) {
        set({ authProviders: result.providers, authProvidersLoading: false });
      } else {
        set({
          authProviders: [],
          authProvidersLoading: false,
          authProvidersError: result.error ?? 'falha ao listar as contas do omp',
        });
      }
    } catch (err) {
      set({
        authProviders: [],
        authProvidersLoading: false,
        authProvidersError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async startProviderLogin(providerId) {
    if (get().loginFlow) return; // single-flight (o main também enforce)
    ensureAuthSubscription();
    activeAuthFlowId = null;
    // Card otimista: spinner até a URL OAuth chegar por push.
    set({ loginFlow: { providerId, phase: 'awaiting-auth' } });
    try {
      const result = await window.nexus.ompAuth.login(providerId);
      if (!result.ok) {
        if (get().loginFlow?.providerId === providerId) set({ loginFlow: null });
        useToastStore
          .getState()
          .push('error', 'Não foi possível iniciar o login', result.error);
        return;
      }
      activeAuthFlowId = result.flowId ?? null;
    } catch (err) {
      if (get().loginFlow?.providerId === providerId) set({ loginFlow: null });
      useToastStore
        .getState()
        .push(
          'error',
          'Não foi possível iniciar o login',
          err instanceof Error ? err.message : String(err),
        );
    }
  },

  async cancelProviderLogin() {
    if (!get().loginFlow) return;
    suppressAuthErrorToast = true;
    set({ loginFlow: null });
    try {
      const result = await window.nexus.ompAuth.cancelLogin();
      if (!result.ok) suppressAuthErrorToast = false;
    } catch {
      suppressAuthErrorToast = false;
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

// Right-drawer exclusivity: closing is a plain state write (never routed back
// through togglePanel), so a claim from the orch panel cannot recurse here.
registerRightDrawer('omp', () => {
  if (useOmpRpcStore.getState().panelOpen) {
    useOmpRpcStore.setState({ panelOpen: false });
  }
});
