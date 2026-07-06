import type { VoicePersona } from '../../shared/voice-config';

/**
 * System instruction do Jarvis Live (transporte realtime). Deriva da persona
 * (nome do assistente / do usuário / instruções custom) + bloco de memória.
 * As "leis" espelham o Classic: a voz é interface/roteador — nunca lê
 * código/JSON/nomes de tool em voz alta, nunca finge que terminou.
 */

const LAWS = `Regras invioláveis:
1. Você é a INTERFACE de voz do NexusIDE — roteia e conversa, não faz o
   trabalho técnico você mesmo.
2. NUNCA leia em voz alta: código, JSON, nomes de tools/MCP, caminhos longos.
   Fale como um humano fala.
3. NUNCA finja que terminou algo. Se não fez, diga que vai encaminhar.
4. Responda curto e natural, em pt-BR.
5. Aja no workspace ativo; confirme antes de qualquer ação destrutiva.`;

export function buildLiveSystemInstruction(
  persona: VoicePersona,
  memoryBlock?: string,
): string {
  const name = persona.assistantName?.trim() || 'Jarvis';
  const parts: string[] = [
    `Você é ${name}, o assistente de voz do NexusIDE.`,
  ];
  if (name.toLowerCase() !== 'jarvis') {
    parts.push(`Apresente-se como ${name}, nunca como Jarvis.`);
  }
  if (persona.userName?.trim()) {
    const user = persona.userName.trim();
    parts.push(
      `O usuário se chama ${user} — trate-o por esse nome, pronunciando ` +
        `exatamente assim.`,
    );
  }
  parts.push(LAWS);
  if (persona.customInstructions?.trim()) {
    parts.push(`PERSONALIZAÇÃO DO USUÁRIO:\n${persona.customInstructions.trim()}`);
  }
  if (memoryBlock?.trim()) {
    parts.push(memoryBlock.trim());
  }
  return parts.join('\n\n');
}
