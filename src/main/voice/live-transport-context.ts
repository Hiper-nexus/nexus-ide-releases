/**
 * Context / system-instruction builders for LiveTransportController.
 */
import { getVoiceConfig } from './voice-config-store';
import { jarvisMemory } from './jarvis-memory';
import { loadJarvisSystemPrompt } from '../jarvis/realtime/factory';
import type { TurnManagedRealtimeProvider } from '../jarvis/realtime/provider';

export function sendProviderContext(
  provider: TurnManagedRealtimeProvider | null,
  latestContext: string,
  recentToolResults: string[],
): void {
  if (!provider?.isReady) return;
  const parts: string[] = [];
  if (latestContext) parts.push(`Current Nexus screen:\n${latestContext}`);
  if (recentToolResults.length > 0) {
    parts.push(`Recent Nexus action results:\n${recentToolResults.join('\n')}`);
  }
  const text = parts.join('\n\n').trim();
  if (text) provider.sendContext(text);
}

export function buildSystemInstruction(): string {
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
  return parts.join('\n\n');
}
