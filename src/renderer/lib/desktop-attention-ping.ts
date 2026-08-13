import {
  agentAttentionPhrase,
  shouldPingHumanForNotification,
  type AgentNotificationKind,
} from '../../shared/agent-notification';

export function notifyDesktopAttention(input: {
  kind: AgentNotificationKind;
  agentLabel: string;
  notify?: (title: string, body: string) => void;
}): boolean {
  if (!shouldPingHumanForNotification(input.kind)) return false;
  const body = agentAttentionPhrase(input.kind, input.agentLabel);
  const fire = input.notify ?? defaultDesktopNotify;
  fire('Nexus', body);
  return true;
}

function defaultDesktopNotify(title: string, body: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: `nexus-attention-${body.slice(0, 48)}` });
  } catch {
    // Notification can throw in some Electron/permission races.
  }
}
