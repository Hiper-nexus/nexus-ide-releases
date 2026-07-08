import type { JarvisAction } from './voice-ipc';

export const NEXUS_REALTIME_ACTION_TOOL = 'nexus_action';

export const SAFE_REALTIME_ACTIONS = [
  'open_squad',
  'open_workspace',
  'design_squad',
  'confirm_squad',
  'new_mission',
  'new_workspace',
  'open_terminal',
  'close_pane',
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
  'focus_previous_pane',
  'focus_pane',
  'send_to_pane',
  'run_command',
  'mcp_tool',
  'restore_mission_panes',
  'ask_pane',
] as const;

export type SafeRealtimeActionType = (typeof SAFE_REALTIME_ACTIONS)[number];

export interface NexusRealtimeActionArgs {
  action?: SafeRealtimeActionType;
  url?: string;
  squadName?: string;
  workspaceName?: string;
  paneName?: string;
  text?: string;
  /** NEW-B: target pane for a routed pending-question answer (send_to_pane). */
  paneId?: string;
  command?: string;
  tool?: string;
  args?: Record<string, unknown>;
  /** restaurar: filtro/nome da missão a restaurar. */
  alvo?: string;
  /** perguntar: pergunta de trabalho a enviar ao pane. */
  pergunta?: string;
}

export function summarizeNexusRealtimeAction(args: NexusRealtimeActionArgs): string {
  switch (args.action) {
    case 'open_squad':
      return args.squadName ? `abrir squad ${args.squadName}` : 'abrir squad';
    case 'open_workspace':
      return args.workspaceName
        ? `abrir workspace ${args.workspaceName}`
        : 'abrir workspace';
    case 'design_squad':
      return 'desenhar squad';
    case 'confirm_squad':
      return 'confirmar e iniciar squad';
    case 'new_mission':
      return 'abrir assistente de missão';
    case 'new_workspace':
      return 'abrir assistente de workspace';
    case 'open_terminal':
      return 'abrir terminal';
    case 'close_pane':
      return 'fechar pane';
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
    case 'focus_previous_pane':
      return 'focar pane anterior';
    case 'focus_pane':
      return args.paneName ? `focar pane ${args.paneName}` : 'focar pane';
    case 'send_to_pane':
      return 'enviar missão ao pane';
    case 'run_command':
      return args.command ? `rodar comando ${args.command}` : 'rodar comando';
    case 'mcp_tool':
      return args.tool ? `executar tool ${args.tool}` : 'executar tool MCP';
    case 'restore_mission_panes':
      return args.alvo ? `restaurar missão ${args.alvo}` : 'restaurar missão recente';
    case 'ask_pane':
      return 'perguntar ao pane';
    default:
      return 'ação realtime';
  }
}

function cleanText(value: unknown, maxChars = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function cleanArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function realtimeArgsToJarvisAction(
  args: NexusRealtimeActionArgs,
): JarvisAction | null {
  if (!args.action) return null;
  if (!SAFE_REALTIME_ACTIONS.includes(args.action)) return null;
  if (args.action === 'open_squad') {
    const squadName = cleanText(args.squadName, 128);
    return squadName ? { type: 'open_squad', squadName } : null;
  }
  if (args.action === 'open_workspace') {
    const workspaceName = cleanText(args.workspaceName, 128);
    return workspaceName ? { type: 'open_workspace', workspaceName } : null;
  }
  if (args.action === 'open_browser') {
    const url = cleanText(args.url, 4_096);
    return url ? { type: 'open_browser', url } : { type: 'open_browser' };
  }
  if (args.action === 'focus_pane') {
    const paneName = cleanText(args.paneName, 128);
    return paneName ? { type: 'focus_pane', paneName } : null;
  }
  if (args.action === 'send_to_pane') {
    const text = cleanText(args.text);
    if (!text) return null;
    const paneId = cleanText(args.paneId, 128);
    return paneId ? { type: 'send_to_pane', text, paneId } : { type: 'send_to_pane', text };
  }
  if (args.action === 'run_command') {
    const command = cleanText(args.command, 2_000);
    return command ? { type: 'run_command', command } : null;
  }
  if (args.action === 'mcp_tool') {
    const tool = cleanText(args.tool, 128);
    if (!/^nexus_[a-z0-9_]+$/i.test(tool)) return null;
    return { type: 'mcp_tool', tool, args: cleanArgs(args.args) };
  }
  if (args.action === 'restore_mission_panes') {
    const alvo = cleanText(args.alvo, 128) || undefined;
    return { type: 'restore_mission_panes', ...(alvo ? { alvo } : {}) };
  }
  if (args.action === 'ask_pane') {
    const pergunta = cleanText(args.pergunta, 4_000);
    if (!pergunta) return null;
    const paneId = cleanText(args.paneId, 128) || undefined;
    return { type: 'ask_pane', pergunta, ...(paneId ? { paneId } : {}) };
  }
  return { type: args.action };
}
