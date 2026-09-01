import os from 'node:os';
import { app } from 'electron';
import {
  appEventsAfter,
  latestAppEventSeq,
  type AppEvent,
} from './app-events';
import { listPaneSnapshots } from '../orch/pane-registry';
import { requireProjectDomainStoreRegistry } from '../orch/project-domain-store-registry';
import { getMcpRuntimeInfo } from '../orch/mcp-server';

/**
 * Nexus Arms — endpoint MCP dedicado ao conector externo.
 *
 * Superfície MÍNIMA por construção: este handler só conhece
 * `nexus_app_observe` e `nexus_app_events`. O token Arms não entra no gate
 * de tools do app — ele jamais poderia chamar spawn, write, files ou
 * qualquer tool de missão. Tudo é metadado: ids, estados e contagens; sem
 * output de terminal, prompts, segredos, e-mails ou paths do usuário.
 */

export interface ArmsSnapshot {
  app: {
    version: string;
    platform: string;
    bootedAt: number | null;
  };
  mcp: { running: boolean; toolCount: number };
  missions: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    updatedAt: number;
  }>;
  panes: ReadonlyArray<{
    paneId: string;
    sessionId: string | null;
    title: string;
    state: string;
    missionId: string | null;
  }>;
  handoffsPending: number;
  events: { latestSeq: number; ringCapacity: number };
  generatedAt: number;
}

const MAX_MISSIONS = 64;
const MAX_EVENTS_PAGE = 128;

let bootedAt: number | null = null;

export function markArmsBoot(at = Date.now()): void {
  bootedAt = at;
}

function snapshotMissions(): ArmsSnapshot['missions'] {
  try {
    const suites = requireProjectDomainStoreRegistry().listSuites();
    const all: Array<{
      id: string;
      title: string;
      status: string;
      updatedAt: number;
    }> = [];
    for (const suite of suites) {
      for (const mission of suite.missions.list()) {
        all.push({
          id: mission.id,
          title: String(mission.title ?? '').slice(0, 200),
          status: String(mission.status ?? 'unknown'),
          updatedAt: mission.updatedAt,
        });
        if (all.length >= MAX_MISSIONS) return all;
      }
    }
    return all;
  } catch {
    return [];
  }
}

function snapshotPanes(): ArmsSnapshot['panes'] {
  try {
    return listPaneSnapshots()
      .slice(0, 128)
      .map((pane) => ({
        paneId: String(pane.paneId ?? ''),
        sessionId: pane.sessionId ?? null,
        title: String(pane.title ?? '').slice(0, 200),
        state: String(pane.state ?? 'unknown'),
        missionId: pane.missionId ?? null,
      }));
  } catch {
    return [];
  }
}

function countPendingHandoffs(): number {
  try {
    let total = 0;
    for (const suite of requireProjectDomainStoreRegistry().listSuites()) {
      total += suite.handoffs
        .list({ includeDelivered: false })
        .filter((handoff) => handoff.status === 'success' || handoff.status === 'blocked')
        .length;
    }
    return total;
  } catch {
    return 0;
  }
}

export function buildArmsSnapshot(now = Date.now()): ArmsSnapshot {
  const runtime = getMcpRuntimeInfo();
  return Object.freeze({
    app: {
      version: app.getVersion(),
      platform: `${os.platform()}/${os.arch()}`,
      bootedAt,
    },
    mcp: { running: runtime.running, toolCount: runtime.toolCount },
    missions: snapshotMissions(),
    panes: snapshotPanes(),
    handoffsPending: countPendingHandoffs(),
    events: { latestSeq: latestAppEventSeq(), ringCapacity: 512 },
    generatedAt: now,
  });
}

export interface ArmsToolResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** Despacho puro da tool — sem rede, sem gate; unit-testado. */
export function dispatchArmsTool(
  name: string,
  args: unknown,
  now = Date.now(),
): ArmsToolResult {
  if (name === 'nexus_app_observe') {
    return { ok: true, result: buildArmsSnapshot(now) };
  }
  if (name === 'nexus_app_events') {
    const rawCursor =
      args && typeof args === 'object' && 'after' in args
        ? (args as { after?: unknown }).after
        : 0;
    const cursor =
      typeof rawCursor === 'number' && Number.isInteger(rawCursor) && rawCursor >= 0
        ? rawCursor
        : 0;
    const page = appEventsAfter(cursor);
    const events: Array<
      Pick<AppEvent, 'seq' | 'at' | 'kind'> & { payload: AppEvent['payload'] }
    > = page.events.slice(0, MAX_EVENTS_PAGE).map((event) => ({
      seq: event.seq,
      at: event.at,
      kind: event.kind,
      payload: event.payload,
    }));
    return {
      ok: true,
      result: {
        events,
        nextCursor: page.nextCursor,
        truncated: page.truncated,
      },
    };
  }
  return { ok: false, error: `unknown tool: ${String(name).slice(0, 64)}` };
}

export const ARMS_TOOLS: ReadonlyArray<{ name: string; description: string }> =
  Object.freeze([
    Object.freeze({
      name: 'nexus_app_observe',
      description:
        'Snapshot JSON do estado do app: versão, missões (id/título/estado), ' +
        'panes (id/estado/missão), handoffs pendentes. Só metadado — sem ' +
        'conteúdo de terminal, prompts ou segredos. Consulte antes de decidir ' +
        'o próximo passo de orquestração externa.',
    }),
    Object.freeze({
      name: 'nexus_app_events',
      description:
        'Fila de eventos de aplicação com cursor: pane.spawned/exited, ' +
        'handoff.submitted/delivered/consumed, mission.state. Passe ' +
        '`after` com o nextCursor da leitura anterior para ler só o que é ' +
        'novo. Eventos antigos podem ser descartados (truncated=true).',
    }),
  ]);

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (value as { method?: unknown }).method === 'string'
  );
}

/**
 * Manipula um lote JSON-RPC MCP já autenticado. Métodos suportados:
 * initialize, tools/list, tools/call, notifications/initialized (no-op).
 * Qualquer outro método responde erro MCP padrão — nunca executa nada.
 */
export function handleArmsJsonRpc(
  batch: unknown,
): ReadonlyArray<Record<string, unknown>> {
  const messages = Array.isArray(batch) ? batch : [batch];
  const responses: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (!isJsonRpcRequest(message)) continue;
    if (message.id === undefined || message.id === null) continue; // notificação
    const reply = (result: unknown): void => {
      responses.push({ jsonrpc: '2.0', id: message.id, result });
    };
    const replyError = (code: number, errorMessage: string): void => {
      responses.push({
        jsonrpc: '2.0',
        id: message.id,
        error: { code, message: errorMessage },
      });
    };
    switch (message.method) {
      case 'initialize':
        reply({
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'nexus-arms', version: app.getVersion() },
          capabilities: { tools: {} },
        });
        break;
      case 'notifications/initialized':
        break;
      case 'tools/list':
        reply({
          tools: ARMS_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: { type: 'object', properties: {} },
          })),
        });
        break;
      case 'tools/call': {
        const params = message.params as
          | { name?: unknown; arguments?: unknown }
          | undefined;
        const name = params?.name;
        if (typeof name !== 'string') {
          replyError(-32602, 'invalid params: name must be a string');
          break;
        }
        const dispatched = dispatchArmsTool(name, params?.arguments ?? {});
        if (!dispatched.ok) {
          reply({
            content: [{ type: 'text', text: dispatched.error ?? 'tool error' }],
            isError: true,
          });
          break;
        }
        reply({
          content: [
            { type: 'text', text: JSON.stringify(dispatched.result, null, 1) },
          ],
        });
        break;
      }
      case 'ping':
        reply({});
        break;
      default:
        replyError(-32601, `method not found: ${message.method.slice(0, 64)}`);
    }
  }
  return responses;
}
