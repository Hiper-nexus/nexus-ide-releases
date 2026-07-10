/**
 * Context / system-instruction builders for LiveTransportController.
 */
import { getVoiceConfig } from './voice-config-store';
import { jarvisMemory } from './jarvis-memory';
import { loadJarvisSystemPrompt } from '../jarvis/realtime/factory';
import type { TurnManagedRealtimeProvider } from '../jarvis/realtime/provider';
import { buildResumeContext } from './live-transport-helpers';

export function sendProviderContext(
  provider: TurnManagedRealtimeProvider | null,
  latestContext: string,
  recentToolResults: string[],
): void {
  if (!provider?.isReady) return;
  if (provider.supportsPassiveContextUpdates === false) return;
  const parts: string[] = [];
  if (latestContext) parts.push(`Current Nexus screen:\n${latestContext}`);
  if (recentToolResults.length > 0) {
    parts.push(`Recent Nexus action results:\n${recentToolResults.join('\n')}`);
  }
  const text = parts.join('\n\n').trim();
  if (text) provider.sendContext(text);
}

export interface LiveInstructionContext {
  latestContext?: string;
  recentToolResults?: readonly string[];
  recentHistory?: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
}

export function buildSystemInstruction(
  session: LiveInstructionContext = {},
): string {
  const config = getVoiceConfig();
  const persona = config.persona;
  const parts = [loadJarvisSystemPrompt()];
  if (persona.assistantName?.trim()) parts.push(`Assistant name: ${persona.assistantName.trim()}.`);
  if (persona.userName?.trim()) parts.push(`User name: ${persona.userName.trim()}.`);
  if (persona.customInstructions?.trim()) {
    parts.push(`User custom instructions:\n${persona.customInstructions.trim()}`);
  }
  const memory = jarvisMemory.factsBlock();
  if (memory.trim()) parts.push(`Long-term memory:\n${memory.trim()}`);
  if (session.latestContext?.trim()) {
    parts.push(
      'Initial Nexus screen snapshot (it may change during the session):\n' +
        session.latestContext.trim().slice(0, 1_200),
    );
  }
  if (session.recentToolResults && session.recentToolResults.length > 0) {
    parts.push(
      `Recent Nexus action results:\n${session.recentToolResults.slice(-5).join('\n')}`,
    );
  }
  if (session.recentHistory && session.recentHistory.length > 0) {
    const history = buildResumeContext(session.recentHistory);
    if (history) parts.push(`Recent conversation before reconnect:\n${history}`);
  }
  parts.push(
    'Screen state can change after this initial snapshot. Before making a ' +
      'claim about the current screen, pane, browser page, mission, or agent ' +
      'output, call the read-only consultar or ler tool to retrieve fresh state.',
  );
  return parts.join('\n\n');
}
