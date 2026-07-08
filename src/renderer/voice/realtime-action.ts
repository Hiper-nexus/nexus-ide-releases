import type { JarvisAction, JarvisLiveToolEvent } from '../../shared/voice-ipc';

function cleanText(value: unknown, maxChars = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function cleanArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function realtimeToolEventToJarvisAction(
  event: JarvisLiveToolEvent,
): JarvisAction | null {
  if (event.source !== 'realtime' || event.name !== 'nexus_action' || !event.callId) {
    return null;
  }
  const action = cleanText(event.args?.action, 128);
  switch (action) {
    case 'open_squad': {
      const squadName = cleanText(event.args?.squadName, 128);
      return squadName ? { type: 'open_squad', squadName } : null;
    }
    case 'open_workspace': {
      const workspaceName = cleanText(event.args?.workspaceName, 128);
      return workspaceName ? { type: 'open_workspace', workspaceName } : null;
    }
    case 'design_squad':
    case 'new_mission':
    case 'new_workspace':
    case 'open_terminal':
    case 'close_pane':
    case 'open_board':
    case 'open_settings':
    case 'open_voice_settings':
    case 'open_canvas':
    case 'open_grid':
    case 'browser_back':
    case 'browser_forward':
    case 'browser_reload':
    case 'focus_next_pane':
    case 'focus_previous_pane':
      return { type: action };
    case 'focus_pane': {
      const paneName = cleanText(event.args?.paneName, 128);
      return paneName ? { type: 'focus_pane', paneName } : null;
    }
    case 'open_browser': {
      const url = cleanText(event.args?.url, 4_096);
      return url ? { type: 'open_browser', url } : { type: 'open_browser' };
    }
    case 'send_to_pane': {
      const text = cleanText(event.args?.text);
      return text ? { type: 'send_to_pane', text } : null;
    }
    case 'run_command': {
      const command = cleanText(event.args?.command, 2_000);
      return command ? { type: 'run_command', command } : null;
    }
    case 'mcp_tool': {
      const tool = cleanText(event.args?.tool, 128);
      if (!/^nexus_[a-z0-9_]+$/i.test(tool)) return null;
      return { type: 'mcp_tool', tool, args: cleanArgs(event.args?.args) };
    }
    default:
      return null;
  }
}
