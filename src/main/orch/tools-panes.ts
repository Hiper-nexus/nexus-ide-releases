import type { McpToolDef } from './mcp-protocol';
import {
  findPane,
  listPaneSnapshots,
  readSessionOutput,
  requestPaneClose,
  waitForIdle,
} from './pane-registry';
import { orchWriteSession } from '../pty/pty-manager';
import { listAdapterInfos } from '../adapters/adapter-registry';
import { findAgent } from './squad-store';
import {
  injectPrompt,
  num,
  requireStr,
  sessionIdOf,
  spawnPaneAndMaybePrompt,
  str,
  strArray,
  type SpawnToolOptions,
} from './tool-util';

/** The 10 pane tools of the embedded MCP server (tool group 1). */

const paneSpawn: McpToolDef = {
  name: 'nexus_pane_spawn',
  description:
    'Open a new terminal pane running an AI CLI. Provide agentName (a squad ' +
    'agent — inherits allowlists/title) and ALSO adapterId/model/effort from ' +
    'nexus_route_task: the explicit adapterId/model WIN over the roster ' +
    'defaults (cost routing). Optional prompt is typed into the CLI once it ' +
    'boots. Returns {paneId, sessionId}.',
  inputSchema: {
    type: 'object',
    properties: {
      adapterId: { type: 'string', description: 'Adapter id (cli) to run' },
      agentName: { type: 'string', description: 'Squad agent name or id' },
      model: { type: 'string' },
      effort: {
        type: 'string',
        description:
          'Reasoning effort for this spawn (low|medium|high|xhigh) — use ' +
          'the value returned by nexus_route_task',
      },
      cwd: { type: 'string' },
      title: { type: 'string' },
      missionId: { type: 'string' },
      prompt: { type: 'string' },
    },
  },
  handler: async (args, ctx) => {
    const agentRef = str(args, 'agentName');
    let options: SpawnToolOptions;
    if (agentRef) {
      const found = findAgent(agentRef);
      if (!found) throw new Error(`unknown squad agent: ${agentRef}`);
      const { agent } = found;
      options = {
        // Roteamento de custo: o adapterId vindo do route_task vence o
        // default do roster — senão o squad inteiro cai num modelo só.
        adapterId: str(args, 'adapterId') ?? agent.cli,
        model: str(args, 'model') ?? agent.model,
        effort: str(args, 'effort') ?? agent.effort,
        cwd: str(args, 'cwd'),
        title: str(args, 'title') ?? agent.agentName,
        missionId: str(args, 'missionId') ?? ctx.missionId,
        agentName: agent.agentName,
        allowedTools: agent.allowedTools ?? null,
        allowedSkills: agent.allowedSkills ?? null,
        role: agent.category === 'orchestrator' ? 'orchestrator' : 'worker',
        prompt: str(args, 'prompt'),
      };
    } else {
      options = {
        adapterId: requireStr(args, 'adapterId'),
        model: str(args, 'model'),
        effort: str(args, 'effort'),
        cwd: str(args, 'cwd'),
        title: str(args, 'title'),
        missionId: str(args, 'missionId') ?? ctx.missionId,
        prompt: str(args, 'prompt'),
      };
    }
    return spawnPaneAndMaybePrompt(options);
  },
};

const paneList: McpToolDef = {
  name: 'nexus_pane_list',
  description:
    'List every pane in the workspace with its live state ' +
    '(spawning|busy|idle|exited), adapter, model and mission binding.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => listPaneSnapshots(),
};

const paneListProviders: McpToolDef = {
  name: 'nexus_pane_list_providers',
  description:
    'List the CLI/API providers (adapters) available on this machine: id, ' +
    'label, models, install status.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => listAdapterInfos(),
};

const paneRead: McpToolDef = {
  name: 'nexus_pane_read',
  description:
    "Read the tail of a pane's terminal output as plain text (ANSI " +
    'stripped). paneId also accepts a sessionId.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      lines: {
        type: 'number',
        description: 'Max lines from the tail (default 200)',
      },
    },
    required: ['paneId'],
  },
  handler: async (args) => {
    const sessionId = sessionIdOf(requireStr(args, 'paneId'));
    return readSessionOutput(sessionId, num(args, 'lines') ?? 200);
  },
};

const paneReadMany: McpToolDef = {
  name: 'nexus_pane_read_many',
  description: 'Read the output tails of several panes at once.',
  inputSchema: {
    type: 'object',
    properties: {
      paneIds: { type: 'array', items: { type: 'string' } },
      lines: { type: 'number' },
    },
    required: ['paneIds'],
  },
  handler: async (args) => {
    const lines = num(args, 'lines') ?? 200;
    return strArray(args, 'paneIds').map((paneId) => {
      try {
        return {
          paneId,
          output: readSessionOutput(sessionIdOf(paneId), lines),
        };
      } catch (err) {
        return {
          paneId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  },
};

const paneWrite: McpToolDef = {
  name: 'nexus_pane_write',
  description:
    "Type text into a pane's terminal. By default an Enter keypress is sent " +
    'after the text (submit: false to suppress).',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      text: { type: 'string' },
      submit: {
        type: 'boolean',
        description: 'Press Enter after the text (default true)',
      },
    },
    required: ['paneId', 'text'],
  },
  handler: async (args) => {
    const sessionId = sessionIdOf(requireStr(args, 'paneId'));
    const text = typeof args.text === 'string' ? args.text : '';
    if (args.submit === false) {
      orchWriteSession(sessionId, text);
    } else {
      await injectPrompt(sessionId, text);
    }
    return { ok: true };
  },
};

const paneWriteMany: McpToolDef = {
  name: 'nexus_pane_write_many',
  description:
    'Write prompts to several panes in one call. writes: ' +
    '[{paneId, text, submit?}].',
  inputSchema: {
    type: 'object',
    properties: {
      writes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            paneId: { type: 'string' },
            text: { type: 'string' },
            submit: { type: 'boolean' },
          },
          required: ['paneId', 'text'],
        },
      },
    },
    required: ['writes'],
  },
  handler: async (args) => {
    const writes = Array.isArray(args.writes) ? args.writes : [];
    const results: Array<{ paneId: string; ok: boolean; error?: string }> = [];
    for (const raw of writes) {
      const write = raw as { paneId?: string; text?: string; submit?: boolean };
      if (typeof write.paneId !== 'string' || typeof write.text !== 'string') {
        results.push({
          paneId: String(write.paneId),
          ok: false,
          error: 'invalid write',
        });
        continue;
      }
      try {
        const sessionId = sessionIdOf(write.paneId);
        if (write.submit === false) {
          orchWriteSession(sessionId, write.text);
        } else {
          await injectPrompt(sessionId, write.text);
        }
        results.push({ paneId: write.paneId, ok: true });
      } catch (err) {
        results.push({
          paneId: write.paneId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  },
};

const paneClose: McpToolDef = {
  name: 'nexus_pane_close',
  description: 'Close a pane (collapses the layout and kills its session).',
  inputSchema: {
    type: 'object',
    properties: { paneId: { type: 'string' } },
    required: ['paneId'],
  },
  handler: async (args) => {
    const paneRef = requireStr(args, 'paneId');
    const pane = findPane(paneRef);
    if (!pane) throw new Error(`unknown pane: ${paneRef}`);
    if (!requestPaneClose(pane.paneId)) {
      throw new Error('no renderer window available');
    }
    return { ok: true };
  },
};

const paneWaitIdle: McpToolDef = {
  name: 'nexus_pane_wait_idle',
  description:
    "Block until a pane's CLI goes idle (finished responding), exits, or " +
    'the timeout elapses. Returns {state, output} with the fresh tail.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      timeoutMs: { type: 'number', description: 'Default 120000' },
      lines: { type: 'number' },
    },
    required: ['paneId'],
  },
  handler: async (args) => {
    const sessionId = sessionIdOf(requireStr(args, 'paneId'));
    const state = await waitForIdle(
      sessionId,
      num(args, 'timeoutMs') ?? 120_000,
    );
    return {
      state,
      output: readSessionOutput(sessionId, num(args, 'lines') ?? 60),
    };
  },
};

const paneWaitMany: McpToolDef = {
  name: 'nexus_pane_wait_many',
  description:
    'Wait on several panes. returnOn "any" resolves at the first idle pane; ' +
    '"all" waits for every pane (default). Returns per-pane states.',
  inputSchema: {
    type: 'object',
    properties: {
      paneIds: { type: 'array', items: { type: 'string' } },
      returnOn: { type: 'string', enum: ['any', 'all'] },
      timeoutMs: { type: 'number' },
    },
    required: ['paneIds'],
  },
  handler: async (args) => {
    const paneIds = strArray(args, 'paneIds');
    const timeoutMs = num(args, 'timeoutMs') ?? 300_000;
    const waits = paneIds.map(async (paneId) => {
      try {
        const state = await waitForIdle(sessionIdOf(paneId), timeoutMs);
        return { paneId, state };
      } catch (err) {
        return {
          paneId,
          state: 'error' as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    if (args.returnOn === 'any' && waits.length > 0) {
      const first = await Promise.race(waits);
      return { first, pending: paneIds.filter((p) => p !== first.paneId) };
    }
    return Promise.all(waits);
  },
};

export function buildPaneTools(): McpToolDef[] {
  return [
    paneSpawn,
    paneList,
    paneListProviders,
    paneRead,
    paneReadMany,
    paneWrite,
    paneWriteMany,
    paneClose,
    paneWaitIdle,
    paneWaitMany,
  ];
}

/** Reused by nexus_mission_spawn_pane / nexus_agent_invoke. */
export const paneSpawnTool = paneSpawn;
