import {
  NEXUS_REALTIME_ACTION_TOOL,
  SAFE_REALTIME_ACTIONS,
} from '../../../shared/voice-realtime-actions';
import type { RealtimeToolDefinition } from './provider';

export {
  NEXUS_REALTIME_ACTION_TOOL,
  SAFE_REALTIME_ACTIONS,
  realtimeArgsToJarvisAction,
  summarizeNexusRealtimeAction,
  type NexusRealtimeActionArgs,
  type SafeRealtimeActionType,
} from '../../../shared/voice-realtime-actions';

export function createNexusRealtimeTools(): RealtimeToolDefinition[] {
  return [
    {
      type: 'function',
      name: NEXUS_REALTIME_ACTION_TOOL,
      description:
        'Operate Nexus IDE through the audited action executor. Opening an existing project always means open_workspace; new_workspace is only for an explicit request to create a new workspace. Use read_current_view for the visible screen. send_to_pane is ONLY for delegating an engineering task to an AI agent/orchestrator and NEVER writes to a terminal. When the user asks to type, send, execute, or run a shell/terminal command, use run_command with the exact command; it will request native confirmation. Use mcp_tool for Nexus MCP tools. Never claim success before the tool result.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: SAFE_REALTIME_ACTIONS,
            description:
              'The safe Nexus IDE action to execute. read_current_view reads the current visible view; read_pane reads a specific pane.',
          },
          url: {
            type: 'string',
            description:
              'Optional URL for open_browser. Omit unless the user explicitly named a site or URL.',
          },
          squadName: {
            type: 'string',
            description: 'Required for open_squad. Use the spoken squad name.',
          },
          workspaceName: {
            type: 'string',
            description: 'Required only for open_workspace. Use the existing workspace name from the injected recent workspace catalog. Never use open_workspace to create a workspace.',
          },
          intent: {
            type: 'string',
            description:
              'Optional work objective for new_agentic_mission. Omit it when the user only asks to open Agentic mode.',
          },
          paneName: {
            type: 'string',
            description:
              'Required for focus_pane. Use a pane title, agent name, or kind such as terminal, browser, agent, or orchestrator.',
          },
          paneId: {
            type: 'string',
            description:
              'Canonical pane id from the injected pane catalog for read_pane/send_to_pane. A unique spoken pane title is also accepted. Omit for the focused/orchestrator delegation flow.',
          },
          text: {
            type: 'string',
            description:
              'Required for send_to_pane agent delegation only. Never put shell commands here.',
          },
          command: {
            type: 'string',
            description:
              'Required for run_command. Exact shell/terminal command requested by the user, including requests phrased as type/send this command.',
          },
          tool: {
            type: 'string',
            description:
              'Required for mcp_tool. Must be a Nexus MCP tool name beginning with nexus_.',
          },
          args: {
            type: 'object',
            description: 'Arguments for mcp_tool. Use an empty object when no args are needed.',
            additionalProperties: true,
          },
        },
        required: ['action'],
      },
    },
  ];
}
