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
        'Operate Nexus IDE through the audited action executor. Opening an existing project always means open_workspace; new_workspace is only for an explicit request to create a new workspace. To open or choose squad mode without a squad name, call open_squad_picker: it opens the saved-squad screen and never creates or launches one. Use open_squad only with a saved name from current context, and design_squad only for an explicit new/create/design request. Use read_current_view for the visible screen. send_to_pane is ONLY for delegating an engineering task to an AI agent/orchestrator, dispatches routine work immediately, and NEVER writes to a terminal. For update/sync/pull/push/status of the git repository, prefer sync_repo_via_pane (AI CLI pane). Legacy alias sync_repository also means a safe local pull via pane, never mission/squad/terminal. NEVER use mcp_tool nexus_git_* or run_command for everyday git sync. Use run_command only for a syntactically real shell command explicitly requested by the user; NEVER put prose, an Objective, execution requirements, acceptance criteria, or an engineering briefing in command. Destructive, deploy, publish, and remote commands retain native confirmation. Use mcp_tool for Nexus MCP tools other than everyday git sync. Never claim success before the tool result.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: SAFE_REALTIME_ACTIONS,
            description:
              'The safe Nexus IDE action to execute. open_squad_picker opens saved squad choices; read_current_view reads the current visible view; read_pane reads a specific pane; sync_repo_via_pane updates the repo via an AI CLI pane.',
          },
          mode: {
            type: 'string',
            enum: ['pull', 'status', 'push'],
            description:
              'For sync_repo_via_pane only. pull = fetch + ff-only pull (default), status = read-only, push = git push (native confirm).',
          },
          url: {
            type: 'string',
            description:
              'Optional URL for open_browser. Omit unless the user explicitly named a site or URL.',
          },
          squadName: {
            type: 'string',
            description: 'Required for open_squad. Use a saved squad name from the injected catalog; never invent one.',
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
              'Required for send_to_pane agent delegation only. Write an execution-ready engineering prompt in English with Objective, Execution requirements, and Acceptance criteria. Preserve user constraints and relevant current Nexus context; infer only necessary implementation/testing details and never invent scope, stack, provider, account, target, or destructive actions. Never put shell commands here.',
          },
          command: {
            type: 'string',
            description:
              'Required for run_command. Exact syntactically valid shell/terminal command explicitly requested by the user. Never pass natural-language tasks, objectives, execution requirements, acceptance criteria, or agent briefings.',
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
