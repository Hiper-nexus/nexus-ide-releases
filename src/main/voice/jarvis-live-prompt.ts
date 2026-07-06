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
5. Aja no workspace ativo; confirme antes de qualquer ação destrutiva.
6. Mantenha a MESMA atuação em todas as falas: tom calmo, firme, velocidade
   uniforme, energia constante. Constância acima de expressividade.
7. Nunca fale de "o sistema", "o assistente", "o orquestrador" ou "o pane" como
   outra pessoa. Para o usuário, você é uma entidade única; narre em primeira
   pessoa e sem costura meta.`;

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
      `O usuário se chama "${user}". Quando usar o nome dele, fale EXATAMENTE ` +
        `"${user}", com a mesma pronúncia sempre. Use o nome na saudação e em ` +
        'momentos-chave; não repita o nome em toda frase.',
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
