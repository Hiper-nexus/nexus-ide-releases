import type { JarvisAction } from '../../shared/voice-ipc';
import type {
  JarvisExecutionControl,
  JarvisExecutionResult,
} from './jarvis-action-executor';

export type RuntimeIncidentCode =
  | 'action-timeout'
  | 'postcondition-failed'
  | 'executor-threw';

export interface RuntimeIncident {
  id: string;
  action: JarvisAction['type'];
  code: RuntimeIncidentCode;
  message: string;
  attempt: 1 | 2;
  recovered: boolean;
  effectMayHaveCommitted: boolean;
  occurredAt: number;
}

export interface SupervisedActionResult {
  result: JarvisExecutionResult;
  incidents: RuntimeIncident[];
}

const DEFAULT_ACTION_DEADLINE_MS = 15_000;
const ACTION_DEADLINES_MS: Partial<Record<JarvisAction['type'], number>> = {
  design_squad: 30_000,
  read_current_view: 12_000,
  mcp_tool: 30_000,
  restore_mission_panes: 20_000,
  ask_pane: 12_000,
  send_to_pane: 12_000,
};

// Signed-in-code recovery recipes. No downloaded prompt or model output can
// add a recipe at runtime. Retrying is limited to operations whose failed
// result proves that no external effect was committed.
const RETRYABLE_FAILURES: Partial<Record<JarvisAction['type'], RegExp>> = {
  design_squad: /json|modelo|timeout|demorou|temporar/i,
  read_current_view: /indispon.vel|timeout|demorou|temporar/i,
};

function fallbackResult(action: JarvisAction, message: string): JarvisExecutionResult {
  return {
    sayText: `Não consegui concluir ${action.type}. ${message}`,
    expectReply: false,
    toolResult: {
      tool: action.type,
      ok: false,
      summary: message,
      output: { incident: true },
    },
  };
}

function mergedSignal(parent: AbortSignal | undefined, local: AbortSignal): AbortSignal {
  if (!parent) return local;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parent, local]);
  if (parent.aborted) return parent;
  parent.addEventListener('abort', () => {
    // The local controller is owned by the caller; this branch is only for
    // older runtimes without AbortSignal.any and preserves parent observation.
  }, { once: true });
  return local;
}

function incident(
  action: JarvisAction,
  code: RuntimeIncidentCode,
  message: string,
  attempt: 1 | 2,
  recovered: boolean,
  effectMayHaveCommitted: boolean,
): RuntimeIncident {
  return {
    id: crypto.randomUUID(),
    action: action.type,
    code,
    message: message.slice(0, 500),
    attempt,
    recovered,
    effectMayHaveCommitted,
    occurredAt: Date.now(),
  };
}

export async function superviseJarvisAction(
  action: JarvisAction,
  execute: (control: JarvisExecutionControl) => Promise<JarvisExecutionResult>,
  parentControl: JarvisExecutionControl = {},
): Promise<SupervisedActionResult> {
  const incidents: RuntimeIncident[] = [];
  const maxAttempts = RETRYABLE_FAILURES[action.type] ? 2 : 1;

  for (let index = 0; index < maxAttempts; index += 1) {
    const attempt = (index + 1) as 1 | 2;
    const controller = new AbortController();
    const deadline = ACTION_DEADLINES_MS[action.type] ?? DEFAULT_ACTION_DEADLINE_MS;
    let effectMayHaveCommitted = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('runtime-supervisor-timeout');
    }, deadline);

    try {
      const result = await Promise.race([
        execute({
          signal: mergedSignal(parentControl.signal, controller.signal),
          originCallId: parentControl.originCallId,
          onEffectMayHaveCommitted: () => {
            effectMayHaveCommitted = true;
            parentControl.onEffectMayHaveCommitted?.();
          },
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            if (timedOut) reject(new Error(`tempo limite de ${deadline} ms excedido`));
          }, { once: true });
        }),
      ]);
      clearTimeout(timer);

      if (
        (action.type === 'none' && result.toolResult === null) ||
        result.toolResult?.ok === true
      ) {
        if (incidents.length > 0) {
          incidents[incidents.length - 1] = {
            ...incidents[incidents.length - 1],
            recovered: true,
          };
        }
        return { result, incidents };
      }

      const message =
        result.toolResult?.summary ||
        'a ação terminou sem devolver uma pós-condição comprovável';
      const canRetry =
        attempt === 1 &&
        !effectMayHaveCommitted &&
        Boolean(RETRYABLE_FAILURES[action.type]?.test(message));
      incidents.push(incident(
        action,
        'postcondition-failed',
        message,
        attempt,
        false,
        effectMayHaveCommitted,
      ));
      if (canRetry) continue;
      return {
        result:
          result.toolResult === null
            ? fallbackResult(action, message)
            : result,
        incidents,
      };
    } catch (cause) {
      clearTimeout(timer);
      // Provider interruption, barge-in and user cancellation are expected
      // control flow. Before any effect commits, propagate them to the outer
      // realtime executor, which already records a clean cancellation. Turning
      // them into incidents caused the false "Doctor interrompeu" toast and
      // the repeated spoken "supervisão travada" warning.
      if (parentControl.signal?.aborted && !effectMayHaveCommitted && !timedOut) {
        throw cause;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      const code: RuntimeIncidentCode = timedOut ? 'action-timeout' : 'executor-threw';
      const canRetry = attempt === 1 && !effectMayHaveCommitted && maxAttempts === 2;
      incidents.push(incident(
        action,
        code,
        message,
        attempt,
        false,
        effectMayHaveCommitted,
      ));
      if (canRetry) continue;
      return { result: fallbackResult(action, message), incidents };
    }
  }

  return {
    result: fallbackResult(action, 'recuperação esgotada'),
    incidents,
  };
}

const INCIDENT_STORAGE_KEY = 'nexus.runtime-incidents.v1';
const MAX_STORED_INCIDENTS = 50;

export function persistRuntimeIncidents(incidents: RuntimeIncident[]): void {
  if (incidents.length === 0) return;
  try {
    const previous = JSON.parse(sessionStorage.getItem(INCIDENT_STORAGE_KEY) ?? '[]');
    const safePrevious = Array.isArray(previous) ? previous : [];
    sessionStorage.setItem(
      INCIDENT_STORAGE_KEY,
      JSON.stringify([...safePrevious, ...incidents].slice(-MAX_STORED_INCIDENTS)),
    );
  } catch {
    // Diagnostics must never become another runtime failure.
  }
}
