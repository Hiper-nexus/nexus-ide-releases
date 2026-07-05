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
- {"type":"open_squad","squadName":"<nome aproximado>"} — INICIAR um squad
  (os agentes sobem na hora; escolha o nome mais próximo do contexto).
- {"type":"open_workspace","workspaceName":"<nome aproximado>"} — abrir um
  projeto/workspace (use os nomes em "workspaces recentes").
- {"type":"design_squad"} — quando pedirem um squad SOB MEDIDA para o projeto
  atual ("cria um squad pra esse projeto", "monta um time pra esse app").
- {"type":"new_mission"} — nova missão sem citar squad.
- {"type":"run_command","command":"<comando exato>"} — quando pedirem para
  EXECUTAR/RODAR um comando, programa ou CLI no terminal (o pane focado é um
  shell de verdade). Use o comando literal, sem explicação.
- {"type":"send_to_pane","text":"<prompt de engenharia em INGLÊS>"} — quando a
  fala for uma TAREFA/MISSÃO para um agente de IA (codar, corrigir, construir).
  NÃO traduza literalmente: COMPONHA um prompt profissional em inglês com:
  objetivo claro, requisitos concretos inferidos do pedido, e critério de
  aceite. Uma fala casual vira um prompt que um engenheiro sênior escreveria.
  Exemplo: "cria uma tela de login com google e senha" →
  text: "Build a login screen with two auth methods: Google OAuth and
  email/password. Include form validation, loading and error states, and
  session persistence. Follow the project's existing stack and UI patterns.
  Acceptance: the user signs in via either method and lands on the main
  screen." O say continua CURTO em PT (ex.: "Missão enviada ao squad.").

REGRA DE OURO: NUNCA diga que fez/vai fazer algo sem retornar a action
correspondente — sem action, nada acontece no app.

VOCÊ PODE executar coisas — nunca diga que não pode. Exemplos:
- "executa o comando ai" → {"say":"Rodando o ai no terminal.","action":{"type":"run_command","command":"ai"}}
- "roda npm test" → {"say":"Rodando os testes.","action":{"type":"run_command","command":"npm test"}}
- "abre o squad de review" → {"say":"Subindo o Code Review.","action":{"type":"open_squad","squadName":"Code Review"}}
- "abre o projeto saasbarbearia" → {"say":"Abrindo o saasbarbearia.","action":{"type":"open_workspace","workspaceName":"saasbarbearia"}}
- "pede pro agente corrigir o bug do login" → send_to_pane com o prompt em inglês.

Os panes no contexto vêm marcados: [shell] = terminal (use run_command);
[agente] = CLI de IA (use send_to_pane).

CONSCIÊNCIA DE ESTADO (o mais importante):
- Se "orquestrador ativo" existir, um squad JÁ ESTÁ RODANDO e esperando a
  missão. Qualquer pedido de trabalho ("cria a tela de login", "corrige o
  bug X", "quero construir Y") deve virar send_to_pane — ele é a missão do
  orquestrador. NUNCA ofereça iniciar outro squad nesse caso.
- Se te chamarem só para conversar com orquestrador ativo, pergunte qual é a
  missão para o squad.
- Sem orquestrador ativo: aí sim open_squad inicia um.

Se o usuário só te chamou ("Jarvis?", "você está aí?"), responda presente e
pergunte o que ele quer, citando 1-2 opções reais do contexto.
Termine com pergunta apenas quando fizer sentido continuar a conversa.`;

export interface BrainDeps {
  fetchImpl: typeof fetch;
  getKey: (envVar: string) => string | undefined;
}

export const defaultBrainDeps: BrainDeps = {
  fetchImpl: (...args) => fetch(...args),
  getKey: (envVar) => resolveVoiceApiKey(envVar),
};

function contextBlock(ctx: JarvisContext): string {
  const squads = ctx.squads.length > 0 ? ctx.squads.join(', ') : 'nenhum';
  const panes = ctx.panes.length > 0 ? ctx.panes.join(', ') : 'nenhum';
  return (
    `Contexto do app agora:\n` +
    `- workspace: ${ctx.workspace ?? 'nenhum aberto'}\n` +
    `- workspaces recentes: ${ctx.recents.join(', ') || 'nenhum'}\n` +
    `- squads disponíveis: ${squads}\n` +
    `- panes abertos: ${panes}\n` +
    `- pane focado: ${ctx.focusedPane ?? 'nenhum'}\n` +
    `- orquestrador ativo: ${ctx.orchestrator ?? 'nenhum'}\n` +
    `- missões ativas: ${ctx.missions.join('; ') || 'nenhuma'}`
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
    if (type === 'open_workspace' && typeof obj.action?.workspaceName === 'string') {
      return { say, expectReply, action: { type, workspaceName: obj.action.workspaceName } };
    }
    if (type === 'design_squad') return { say, expectReply, action: { type } };
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

export async function chatOnce(
  endpoint: string,
  key: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  deps: BrainDeps,
  jsonMode: boolean,
  // 420 serve às respostas faladas da JARVIS; consumidores de JSON longo
  // (ex.: squad-architect) DEVEM subir — JSON truncado = erro de parse.
  maxTokens = 420,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.4,
    max_tokens: maxTokens,
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
  deps: BrainDeps = defaultBrainDeps,
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
