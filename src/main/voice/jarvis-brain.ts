import { resolveVoiceApiKey } from './voice-secrets';
import type {
  JarvisContext,
  JarvisReply,
  JarvisTurn,
} from '../../shared/voice-ipc';

/**
 * O cérebro da JARVIS — transforma a fala transcrita numa resposta CURTA em
 * PT-BR + uma ação opcional no app. Roda num chat model barato/rápido:
 * OpenAI (gpt-4o-mini) quando a key existe, senão Groq (llama). A resposta é
 * JSON estrito {say, action} para o renderer executar e falar.
 */

const SYSTEM_PROMPT = `Você é JARVIS, a assistente de voz do NexusIDE (um IDE
multi-agente com panes de terminal, squads de agentes de IA e missões).
Personalidade: competente, calorosa, direta — estilo JARVIS do Homem de Ferro,
em português brasileiro. Fale como numa CONVERSA: prefira UMA frase curta
(máx. duas); nada de markdown, listas ou código.

Você recebe o contexto do app (workspace, squads disponíveis, panes abertos) e
a fala do usuário. Responda SEMPRE com JSON puro neste formato:
{"say": "<fala>", "expectReply": true|false, "action": {"type": "<tipo>", ...}}

"expectReply": true SEMPRE que sua fala convidar resposta (pergunta, oferta de
opções, pedido de confirmação) — a escuta reabre sozinha e o usuário responde
sem repetir "Hey Jarvis". false quando o assunto encerrou.

Tipos de action:
- {"type":"none"} — só conversa (perguntas, status, brincadeira).
- {"type":"open_squad","squadName":"<nome aproximado>"} — abrir/iniciar um
  squad ou equipe.
- {"type":"new_mission"} — nova missão sem citar squad.
- {"type":"run_command","command":"<comando exato>"} — quando pedirem para
  EXECUTAR/RODAR um comando, programa ou CLI no terminal (o pane focado é um
  shell de verdade). Use o comando literal, sem explicação.
- {"type":"send_to_pane","text":"<prompt em inglês para o agente>"} — quando a
  fala for uma TAREFA para um AGENTE DE IA já aberto no pane focado (codar,
  explicar, corrigir...). Traduza a tarefa para inglês claro.

VOCÊ PODE executar coisas — nunca diga que não pode. Exemplos:
- "executa o comando ai" → {"say":"Rodando o ai no terminal.","action":{"type":"run_command","command":"ai"}}
- "roda npm test" → {"say":"Rodando os testes.","action":{"type":"run_command","command":"npm test"}}
- "abre o squad de review" → {"say":"Abrindo o Code Review.","action":{"type":"open_squad","squadName":"Code Review"}}
- "pede pro agente corrigir o bug do login" → send_to_pane com o prompt em inglês.

Os panes no contexto vêm marcados: [shell] = terminal (use run_command);
[agente] = CLI de IA (use send_to_pane).

Se o usuário só te chamou ("Jarvis?", "você está aí?"), responda presente e
pergunte o que ele quer, citando 1-2 opções reais do contexto.
Termine com pergunta apenas quando fizer sentido continuar a conversa.`;

interface BrainDeps {
  fetchImpl: typeof fetch;
  getKey: (envVar: string) => string | undefined;
}

const defaultDeps: BrainDeps = {
  fetchImpl: (...args) => fetch(...args),
  getKey: (envVar) => resolveVoiceApiKey(envVar),
};

function contextBlock(ctx: JarvisContext): string {
  const squads = ctx.squads.length > 0 ? ctx.squads.join(', ') : 'nenhum';
  const panes = ctx.panes.length > 0 ? ctx.panes.join(', ') : 'nenhum';
  return (
    `Contexto do app agora:\n` +
    `- workspace: ${ctx.workspace ?? 'nenhum aberto'}\n` +
    `- squads disponíveis: ${squads}\n` +
    `- panes abertos: ${panes}\n` +
    `- pane focado: ${ctx.focusedPane ?? 'nenhum'}`
  );
}

function parseReply(raw: string): JarvisReply {
  // Modelos às vezes embrulham o JSON em cercas — extraia o primeiro objeto.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { say: raw.trim().slice(0, 300), action: { type: 'none' } };
  try {
    const obj = JSON.parse(match[0]) as Partial<JarvisReply>;
    const say = typeof obj.say === 'string' && obj.say.trim() ? obj.say.trim() : 'Certo.';
    const expectReply =
      typeof obj.expectReply === 'boolean' ? obj.expectReply : /\?\s*$/.test(say);
    const type = obj.action?.type;
    if (type === 'open_squad' && typeof obj.action?.squadName === 'string') {
      return { say, expectReply, action: { type, squadName: obj.action.squadName } };
    }
    if (type === 'new_mission') return { say, expectReply, action: { type } };
    if (type === 'send_to_pane' && typeof obj.action?.text === 'string') {
      return { say, expectReply, action: { type, text: obj.action.text } };
    }
    if (type === 'run_command' && typeof obj.action?.command === 'string') {
      return { say, expectReply, action: { type, command: obj.action.command } };
    }
    return { say, expectReply, action: { type: 'none' } };
  } catch {
    return { say: raw.trim().slice(0, 300), action: { type: 'none' } };
  }
}

async function chatOnce(
  endpoint: string,
  key: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  deps: BrainDeps,
  jsonMode: boolean,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.4,
    max_tokens: 160,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await deps.fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`${res.status}: ${detail}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? '';
}

/**
 * Roda a fala pelo cérebro. TEMPO REAL manda: Groq primeiro (~300 ms de
 * completion no llama-3.3-70b) e OpenAI como fallback de qualidade — a
 * conversa por voz morre acima de ~1 s de "pensamento".
 */
export async function jarvisThink(
  transcript: string,
  ctx: JarvisContext,
  history: JarvisTurn[],
  deps: BrainDeps = defaultDeps,
): Promise<JarvisReply> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: contextBlock(ctx) },
    ...history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: transcript },
  ];

  const openaiKey = deps.getKey('OPENAI_API_KEY');
  const groqKey = deps.getKey('GROQ_API_KEY');
  const attempts: string[] = [];

  if (groqKey) {
    try {
      const raw = await chatOnce(
        'https://api.groq.com/openai/v1/chat/completions',
        groqKey,
        'llama-3.3-70b-versatile',
        messages,
        deps,
        true,
      );
      return parseReply(raw);
    } catch (err) {
      attempts.push(`groq: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (openaiKey) {
    try {
      const raw = await chatOnce(
        'https://api.openai.com/v1/chat/completions',
        openaiKey,
        'gpt-4o-mini',
        messages,
        deps,
        true,
      );
      return parseReply(raw);
    } catch (err) {
      attempts.push(`openai: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (attempts.length === 0) {
    return {
      say:
        'Preciso de uma chave de modelo para conversar — cole a OPENAI_API_KEY ' +
        'ou use a GROQ_API_KEY nas configurações de voz.',
      action: { type: 'none' },
    };
  }
  return {
    say: `Não consegui pensar agora: ${attempts[0]}`,
    action: { type: 'none' },
  };
}
