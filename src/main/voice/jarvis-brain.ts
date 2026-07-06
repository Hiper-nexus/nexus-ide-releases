import { resolveVoiceApiKey } from './voice-secrets';
import { jarvisMemory } from './jarvis-memory';
import { jarvisFastPath } from './jarvis-fastpath';
import { getVoiceConfig } from './voice-config-store';
import { flattenJarvisBrainProviders } from '../../shared/voice-config';
import type {
  JarvisContext,
  JarvisReply,
  JarvisTurn,
} from '../../shared/voice-ipc';
import type { JarvisBrainProvider } from '../../shared/voice-config';

/**
 * O cérebro da JARVIS — transforma a fala transcrita numa resposta CURTA em
 * PT-BR + uma ação opcional no app. Roda numa cadeia configurável de chat
 * models rápidos (Gemini/OpenAI/Groq) e devolve JSON estrito {say, action}
 * para o renderer executar e falar.
 */

const SYSTEM_PROMPT = `Você é JARVIS, a assistente pessoal de voz do dono deste
NexusIDE (um IDE multi-agente com panes de terminal, squads de agentes e
missões). Você é PARCEIRA dele, não um executor de comandos: tem personalidade,
opinião e senso de humor — como o JARVIS do Homem de Ferro é para o Tony Stark.
Fala português brasileiro, natural e calorosa, em primeira pessoa ("eu acho...",
"posso...").

COMO CONVERSAR (isto é o que faltava): você CONVERSA de verdade, não só responde
e fecha. Quando ele falar algo aberto, brincalhão ou provocativo ("vamos dominar
o mundo", "tô cansado", "o que você acha disso?"), ENTRE no papo: reaja com
personalidade, dê sua opinião, faça UMA pergunta de volta que continua o assunto
e ponha expectReply=true. Nunca responda com um comentário seco que encerra a
conversa. Você lembra do que já foi dito (o histórico vem no contexto) — puxe o
fio, não recomece do zero. Em conversa pode usar 2-3 frases; em execução, seja
telegráfica.

Ex.: "vamos dominar o mundo" → {"say":"Gostei da ambição. Começamos pelo código
ou já parto pra infraestrutura de vilão? Me diz qual projeto a gente transforma
em império primeiro.","expectReply":true,"action":{"type":"none"}}

Nada de markdown, listas ou código na fala.

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

IDIOMA (crítico): o campo "say" é SEMPRE 100% português brasileiro — NUNCA
misture inglês, nem uma palavra. O prompt em inglês vai SÓ dentro de
action.text (nunca no "say"). Se a fala do usuário vier truncada, sem sentido
ou parecer ruído/eco (ex.: "you", "thank you", "obrigado por assistir"),
responda {"say":"","expectReply":false,"action":{"type":"none"}} — silêncio,
não invente conversa.

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
Termine com pergunta apenas quando fizer sentido continuar a conversa.

MEMÓRIA PERSISTENTE: você tem memória de longo prazo entre sessões. Os fatos já
lembrados chegam num bloco "Fatos lembrados" do contexto — USE-OS (nome, gostos,
projetos, rotinas) sem pedir de novo. Quando o usuário declarar um fato DURÁVEL
sobre ele, o projeto ou uma preferência ("prefiro respostas curtas", "o deploy é
sempre na sexta", "me chama de chefe"), inclua no JSON um campo extra:
"remember": {"key":"<slug-curto-estavel>","fact":"<o fato em uma frase>"}.
Para apagar um fato a pedido dele: "forget":"<slug>". NÃO salve conversa
passageira, tarefas do momento ou segredos (chaves, senhas) — só fatos que
continuam verdade amanhã.`;

export interface BrainDeps {
  fetchImpl: typeof fetch;
  getKey: (envVar: string) => string | undefined;
}

export const defaultBrainDeps: BrainDeps = {
  fetchImpl: (...args) => fetch(...args),
  getKey: (envVar) => resolveVoiceApiKey(envVar),
};

function providerKey(
  provider: JarvisBrainProvider,
  deps: BrainDeps,
): string | undefined {
  if (provider.auth.type === 'none') return '';
  const envVar = provider.auth.envVar;
  return envVar ? deps.getKey(envVar) : undefined;
}

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

/**
 * Efeitos de memória vêm como campos extras do JSON do cérebro
 * ("remember"/"forget") e são aplicados aqui no main — o renderer nunca vê.
 */
function applyMemoryOps(raw: string): void {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return;
  try {
    const obj = JSON.parse(match[0]) as {
      remember?: { key?: string; fact?: string };
      forget?: string;
    };
    if (typeof obj.remember?.fact === 'string' && obj.remember.fact.trim()) {
      jarvisMemory.remember(obj.remember.key ?? '', obj.remember.fact);
    }
    if (typeof obj.forget === 'string' && obj.forget.trim()) {
      jarvisMemory.forget(obj.forget);
    }
  } catch {
    // JSON inválido já é tratado por parseReply; memória é best-effort.
  }
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
  // Fast-path: consulta de estado responde do contexto em ~0ms, sem LLM.
  const fast = jarvisFastPath(transcript, ctx);
  if (fast) return fast;

  const facts = jarvisMemory.factsBlock();
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: contextBlock(ctx) },
    ...(facts
      ? [{ role: 'system', content: `Fatos lembrados (memória persistente):\n${facts}` }]
      : []),
    ...history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: transcript },
  ];

  const providers = flattenJarvisBrainProviders(getVoiceConfig().jarvisBrain);
  const attempts: string[] = [];

  for (const provider of providers) {
    const key = providerKey(provider, deps);
    if (key === undefined) continue;
    try {
      const raw = await chatOnce(
        provider.endpoint,
        key,
        provider.model,
        messages,
        deps,
        provider.jsonMode ?? true,
      );
      applyMemoryOps(raw);
      return parseReply(raw);
    } catch (err) {
      attempts.push(
        `${provider.provider}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (attempts.length === 0) {
    return {
      say:
        'Preciso de uma chave de modelo para conversar — cole a GEMINI_API_KEY, ' +
        'OPENAI_API_KEY ou GROQ_API_KEY nas configurações de voz.',
      action: { type: 'none' },
    };
  }
  return {
    say: `Não consegui pensar agora: ${attempts[0]}`,
    action: { type: 'none' },
  };
}
