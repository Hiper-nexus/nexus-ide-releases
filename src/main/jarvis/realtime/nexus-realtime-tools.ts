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
        'Operate Nexus IDE through the same audited action executor used by Classic Jarvis. Use safe UI actions directly, use send_to_pane for agent delegation, run_command only when the user explicitly asks to run a shell command, and mcp_tool for Nexus MCP tools. Sensitive tools still require native confirmation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: SAFE_REALTIME_ACTIONS,
            description: 'The safe Nexus IDE action to execute.',
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
            description: 'Required for open_workspace. Use the spoken workspace name.',
          },
          paneName: {
            type: 'string',
            description:
              'Required for focus_pane. Use a pane title, agent name, or kind such as terminal, browser, agent, or orchestrator.',
          },
          paneId: {
            type: 'string',
            description:
              'Optional pane id/name for read_pane. Omit or use "ativo" for the focused pane.',
          },
          text: {
            type: 'string',
            description:
              'Required for send_to_pane. Write a concise engineering prompt in English.',
          },
          command: {
            type: 'string',
            description:
              'Required for run_command. Exact shell command requested by the user.',
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
