/**
 * Registro em memória de personas de agente (nome → system-prompt).
 *
 * Completamente independente de voice-ipc: a persona de voz (assistantName,
 * userName, customInstructions) vive em src/main/voice/voice-config-store.ts
 * e serve ao Jarvis. Este módulo serve à identidade de agente-folha no spawn.
 */

const registry = new Map<string, string>();

export function registerPersona(name: string, systemPrompt: string): void {
  if (!name) throw new Error('persona name must not be empty');
  if (!systemPrompt) throw new Error('persona systemPrompt must not be empty');
  registry.set(name, systemPrompt);
}

export function lookupPersonaSystemPrompt(name: string): string | null {
  return registry.get(name) ?? null;
}

/** Limpa o registry. Uso exclusivo em testes. */
export function clearPersonasForTests(): void {
  registry.clear();
}

export function listPersonaNames(): string[] {
  return [...registry.keys()];
}
