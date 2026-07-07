import type { JarvisAction } from '../../../shared/voice-ipc';
import type { RealtimeToolDefinition } from './provider';

export const NEXUS_REALTIME_ACTION_TOOL = 'nexus_action';

export const SAFE_REALTIME_ACTIONS = [
  'new_mission',
  'new_workspace',
  'open_terminal',
  'open_board',
  'open_settings',
  'open_voice_settings',
  'open_canvas',
  'open_grid',
  'open_browser',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'focus_next_pane',
] as const;

export type SafeRealtimeActionType = (typeof SAFE_REALTIME_ACTIONS)[number];

export interface NexusRealtimeActionArgs {
  action?: SafeRealtimeActionType;
  url?: string;
}

export function createNexusRealtimeTools(): RealtimeToolDefinition[] {
  return [
    {
      type: 'function',
      name: NEXUS_REALTIME_ACTION_TOOL,
      description:
        'Operate safe, non-destructive Nexus IDE UI actions. Use this when the user asks to open a terminal, create a workspace/mission, switch canvas/grid, open settings, open or navigate the embedded browser, or focus another pane. Do not use this for shell commands or destructive actions.',
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
        },
        required: ['action'],
      },
    },
  ];
}

export function summarizeNexusRealtimeAction(args: NexusRealtimeActionArgs): string {
  switch (args.action) {
    case 'new_mission':
      return 'abrir assistente de missão';
    case 'new_workspace':
      return 'abrir assistente de workspace';
    case 'open_terminal':
      return 'abrir terminal';
    case 'open_board':
      return 'abrir quadro';
    case 'open_settings':
      return 'abrir configurações';
    case 'open_voice_settings':
      return 'abrir configurações de voz';
    case 'open_canvas':
      return 'abrir canvas';
    case 'open_grid':
      return 'abrir grade';
    case 'open_browser':
      return args.url ? `abrir browser em ${args.url}` : 'abrir browser';
    case 'browser_back':
      return 'voltar no browser';
    case 'browser_forward':
      return 'avançar no browser';
    case 'browser_reload':
      return 'recarregar browser';
    case 'focus_next_pane':
      return 'focar próximo pane';
    default:
      return 'ação realtime';
  }
}

export function realtimeArgsToJarvisAction(
  args: NexusRealtimeActionArgs,
): JarvisAction | null {
  if (!args.action) return null;
  if (!SAFE_REALTIME_ACTIONS.includes(args.action)) return null;
  if (args.action === 'open_browser') {
    return args.url ? { type: 'open_browser', url: args.url } : { type: 'open_browser' };
  }
  return { type: args.action };
}
