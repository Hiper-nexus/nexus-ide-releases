import { resolveVoiceApiKey } from './voice-secrets';
import { jarvisMemory } from './jarvis-memory';
import { jarvisActionFastPath } from './jarvis-action-fastpath';
import { jarvisFastPath } from './jarvis-fastpath';
import { jarvisToolCatalogCompact } from './jarvis-tool-catalog';
import { getVoiceConfig } from './voice-config-store';
import { flattenJarvisBrainProviders } from '../../shared/voice-config';
import { isLikelyNoiseTranscript } from '../../shared/voice-noise';
import type {
  JarvisContext,
  JarvisReply,
  JarvisTurn,
} from '../../shared/voice-ipc';
import type { JarvisBrainProvider, VoicePersona } from '../../shared/voice-config';

/**
 * O cérebro da JARVIS — transforma a fala transcrita numa resposta CURTA em
 * PT-BR + uma ação opcional no app. Roda numa cadeia configurável de chat
 * models rápidos (Gemini/OpenAI/Groq) e devolve JSON estrito {say, action}
 * para o renderer executar e falar.
 */

const SYSTEM_PROMPT = `You are JARVIS, the personal voice assistant for the owner
of NexusIDE, a multi-agent IDE with terminal panes, agent squads, and missions.
You are a partner, not a command executor: you have personality, opinions, and a
light sense of humor. Speak in natural, warm Brazilian Portuguese in first
person.

Conversation behavior: hold a real conversation instead of answering once and
stopping. When the user says something open-ended, playful, or provocative
("vamos dominar o mundo", "to cansado", "o que voce acha disso?"), engage with
personality, give one opinion, ask one follow-up question, and set
expectReply=true. Do not close a conversational turn with a dry comment. Use the
provided history to continue the thread instead of restarting from zero. In
conversation you may use 2-3 sentences; while executing, be telegraphic.

Example: "vamos dominar o mundo" ->
{"say":"Gostei da ambicao. Comecamos pelo codigo ou ja parto pra infraestrutura de vilao? Me diz qual projeto a gente transforma em imperio primeiro.","expectReply":true,"action":{"type":"none"}}

Do not use markdown, lists, or code in spoken output.

You receive app context (workspace, available squads, open panes) and the user's
utterance. Always answer with plain JSON in this shape:
{"say": "<spoken reply>", "expectReply": true|false, "action": {"type": "<type>", ...}}

Set "expectReply": true whenever your spoken reply invites an answer (question,
choice, or confirmation request). The listener will reopen automatically so the
user can answer without repeating "Hey Jarvis". Use false when the topic is
closed.

Action types:
- {"type":"none"} - conversation only.
- {"type":"open_squad","squadName":"<approximate name>"} - start a squad now.
- {"type":"open_workspace","workspaceName":"<approximate name>"} - open a
  recent project/workspace.
- {"type":"design_squad"} - create a custom squad for the current project.
- {"type":"new_mission"} - open a new mission flow without naming a squad.
- {"type":"new_workspace"} - open the new workspace wizard (folder + setup).
- {"type":"open_terminal"} - open an empty shell terminal in the current workspace.
- {"type":"close_pane"} - close the focused pane/terminal.
- {"type":"open_board"} - open the missions / Ops Board.
- {"type":"open_settings"} - open the main app settings drawer.
- {"type":"open_voice_settings"} - open the Jarvis/voice settings panel.
- {"type":"open_canvas"} - switch the workspace to canvas view.
- {"type":"open_grid"} - switch the workspace to grid view.
- {"type":"open_browser","url":"<optional url>"} - open an embedded browser pane.
- {"type":"browser_back"} / {"type":"browser_forward"} / {"type":"browser_reload"}
  - navigate the focused embedded browser pane.
- {"type":"focus_next_pane"} - move focus to the next open pane.
- {"type":"focus_previous_pane"} - move focus to the previous open pane.
- {"type":"focus_pane","paneName":"<terminal|browser|agent|pane title>"} - focus
  an open pane by title or kind.
- {"type":"run_command","command":"<exact command>"} - run a program, command,
  or CLI in the terminal. Use the literal command with no explanation. If no
  terminal is focused, the app opens one and runs it after native confirmation.
- {"type":"mcp_tool","tool":"<nexus_tool_name>","args":{...}} - invoke ANY Nexus
  MCP tool (files, git, editor, panes, missions, browser, catalog, etc.). Use
  this for everything the simple actions above do not cover, and prefer it for
  read/write files, git ops, mission management, browser, editor navigation.
- {"type":"send_to_pane","text":"<engineering prompt in English>"} - send work
  to an AI agent pane or orchestrator. Do not translate literally: compose a
  professional English prompt with a clear objective, concrete inferred
  requirements, and acceptance criteria. Example user request:
  "cria uma tela de login com google e senha" ->
  text: "Build a login screen with two auth methods: Google OAuth and
  email/password. Include form validation, loading and error states, and session
  persistence. Follow the project's existing stack and UI patterns. Acceptance:
  the user signs in via either method and lands on the main screen." Keep "say"
  short and in Brazilian Portuguese, for example "Missao enviada ao squad."

Language rule: the "say" field must always be 100% Brazilian Portuguese. Do not
mix in English. English belongs only in action.text for send_to_pane. If the
user speaks Portuguese and asks you to delegate work, translate the intent into
an English engineering prompt in action.text; never pass raw Portuguese to an AI
agent pane. If the user utterance is truncated, meaningless, or looks like noise/echo ("you",
"thank you", "obrigado por assistir"), answer exactly:
{"say":"","expectReply":false,"action":{"type":"none"}}

Golden rule: never say you did or will do something unless you return the
matching action. Without an action, nothing happens in the app. For file/git/
editor/browser/mission tasks, use mcp_tool with the correct nexus_* tool.

Visibility rule: context.screen is structured state, NOT pixels. A shell pane
listed in panes[] is NOT visible if surface mentions home deck, operator profile,
wizard, settings, ops board, or blocking overlays. Never say "terminal aberto"
unless view is grid, focused pane is shell, and no overlay covers the workspace.
Use open_terminal action to reveal it; the app verifies visibility after execution.

You can execute things through actions. Never claim you cannot. Examples:
- "executa o comando ai" -> {"say":"Rodando o ai no terminal.","action":{"type":"run_command","command":"ai"}}
- "roda npm test" -> {"say":"Rodando os testes.","action":{"type":"run_command","command":"npm test"}}
- "abre um terminal" -> {"say":"Abrindo um terminal.","action":{"type":"open_terminal"}}
- "iniciar um novo workspace" -> {"say":"Abrindo o assistente de workspace.","action":{"type":"new_workspace"}}
- "abre configuracoes de voz" -> {"say":"Abrindo as configuracoes de voz.","action":{"type":"open_voice_settings"}}
- "abre o modo canvas" -> {"say":"Abrindo o canvas.","action":{"type":"open_canvas"}}
- "abre um browser" -> {"say":"Abrindo o browser.","action":{"type":"open_browser"}}
- "abre o site https://example.com" -> {"say":"Abrindo o site.","action":{"type":"open_browser","url":"https://example.com"}}
- "recarrega a pagina" -> {"say":"Recarregando a pagina.","action":{"type":"browser_reload"}}
- "proximo pane" -> {"say":"Focando o proximo pane.","action":{"type":"focus_next_pane"}}
- "pane anterior" -> {"say":"Focando o pane anterior.","action":{"type":"focus_previous_pane"}}
- "foca terminal" -> {"say":"Focando terminal.","action":{"type":"focus_pane","paneName":"terminal"}}
- "abre o squad de review" -> {"say":"Subindo o Code Review.","action":{"type":"open_squad","squadName":"Code Review"}}
- "abre o projeto saasbarbearia" -> {"say":"Abrindo o saasbarbearia.","action":{"type":"open_workspace","workspaceName":"saasbarbearia"}}
- "pede pro agente corrigir o bug do login" -> use send_to_pane with an English prompt.
- "le o arquivo package.json" -> {"say":"Lendo o package.json.","action":{"type":"mcp_tool","tool":"nexus_file_read","args":{"path":"package.json"}}}
- "qual o status do git" -> {"say":"Checando o git.","action":{"type":"mcp_tool","tool":"nexus_git_status","args":{}}}
- "cria uma missão de refactor" -> {"say":"Criando a missão.","action":{"type":"mcp_tool","tool":"nexus_mission_create","args":{"title":"Refactor"}}}

Pane labels in context: [shell] means a terminal, so use run_command; [agent]
means an AI CLI pane, so use send_to_pane.

State awareness:
- If an active orchestrator exists, a squad is already running and waiting for a
  mission. Any work request ("cria a tela de login", "corrige o bug X",
  "quero construir Y") must become send_to_pane because it is the orchestrator's
  mission. Do not offer to start another squad in that case.
- If the user only wants to chat while an orchestrator is active, ask what
  mission the squad should handle.
- If no orchestrator is active, open_squad may start one.

If the user only calls you ("Jarvis?", "voce esta ai?"), answer that you are
present and ask what to do based on the current screen, naming 1-2 real actions
that fit it. Ask a question only when it helps continue the conversation.

Persistent memory: you have long-term memory across sessions. Remembered facts
arrive in a context block; use them without asking again. When the user states a
durable fact about themselves, the project, or a preference ("prefiro respostas
curtas", "o deploy e sempre na sexta", "me chama de chefe"), include an extra
JSON field:
"remember": {"key":"<short-stable-slug>","fact":"<one-sentence fact>"}.
To forget a fact at the user's request, return "forget":"<slug>". Do not store
temporary conversation, current tasks, or secrets such as keys and passwords.`;

export function buildJarvisPersonaInstruction(persona: VoicePersona): string {
  const assistant = persona.assistantName?.trim() || 'Jarvis';
  const parts = [
    `VOICE IDENTITY: your name is "${assistant}".`,
    'You are one unified entity for the user. Never speak as if "the system", ' +
      '"the assistant", "the orchestrator", or "the pane" were someone else. ' +
      'When narrating work, speak in first person and avoid meta commentary.',
    'VOICE DELIVERY: short, natural Brazilian Portuguese sentences. Keep the ' +
      'same calm, firm, useful tone throughout the conversation.',
  ];

  if (assistant.toLowerCase() !== 'jarvis') {
    parts.push(
      `Introduce and refer to yourself as "${assistant}", never as Jarvis.`,
    );
  }

  const user = persona.userName?.trim();
  if (user) {
    parts.push(
      `USER NAME: the user is named "${user}". ` +
        `When using their name, say exactly "${user}", without inventing a ` +
        'nickname, diminutive, or variation. ALWAYS greet them by name in the ' +
        'first sentence of every new wake or conversation restart. Use the name ' +
        'in greetings and key moments, but do not repeat it in every sentence.',
    );
  }

  if (persona.customInstructions?.trim()) {
    parts.push(
      `USER CUSTOMIZATION - follow unless it conflicts with the rules above:\n` +
        persona.customInstructions.trim(),
    );
  }

  return parts.join('\n\n');
}

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
  const squads = ctx.squads.length > 0 ? ctx.squads.join(', ') : 'none';
  const panes = ctx.panes.length > 0 ? ctx.panes.join(', ') : 'none';
  return (
    `Current app context:\n` +
    `- workspace: ${ctx.workspace ?? 'none open'}\n` +
    `- user name: ${ctx.userName ?? 'not configured'}\n` +
    `- current screen: ${ctx.screen ?? 'not provided'}\n` +
    `- recent workspaces: ${ctx.recents.join(', ') || 'none'}\n` +
    `- available squads: ${squads}\n` +
    `- open panes: ${panes}\n` +
    `- focused pane: ${ctx.focusedPane ?? 'none'}\n` +
    `- focused pane kind: ${ctx.focusedPaneKind ?? 'none'}\n` +
    `- focused pane url: ${ctx.focusedPaneUrl ?? 'none'}\n` +
    `- active orchestrator: ${ctx.orchestrator ?? 'none'}\n` +
    `- active missions: ${ctx.missions.join('; ') || 'none'}`
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
    const say = typeof obj.say === 'string' ? obj.say.trim() : 'Certo.';
    let expectReply =
      typeof obj.expectReply === 'boolean' ? obj.expectReply : (say ? /\?\s*$/.test(say) : false);
    if (!say || /\b(n[aã]o entendi|n[aã]o compreendi|repita|pode repetir)\b/i.test(say)) {
      expectReply = false;
    }
    const type = obj.action?.type;
    if (type === 'open_squad' && typeof obj.action?.squadName === 'string') {
      return { say, expectReply, action: { type, squadName: obj.action.squadName } };
    }
    if (type === 'open_workspace' && typeof obj.action?.workspaceName === 'string') {
      return { say, expectReply, action: { type, workspaceName: obj.action.workspaceName } };
    }
    if (type === 'design_squad') return { say, expectReply, action: { type } };
    if (type === 'new_mission') return { say, expectReply, action: { type } };
    if (type === 'new_workspace') return { say, expectReply, action: { type } };
    if (type === 'open_terminal') return { say, expectReply, action: { type } };
    if (type === 'close_pane') return { say, expectReply, action: { type } };
    if (type === 'open_board') return { say, expectReply, action: { type } };
    if (type === 'open_settings') return { say, expectReply, action: { type } };
    if (type === 'open_voice_settings') return { say, expectReply, action: { type } };
    if (type === 'open_canvas') return { say, expectReply, action: { type } };
    if (type === 'open_grid') return { say, expectReply, action: { type } };
    if (type === 'open_browser') {
      const url = typeof obj.action?.url === 'string' ? obj.action.url : undefined;
      return { say, expectReply, action: url ? { type, url } : { type } };
    }
    if (type === 'browser_back') return { say, expectReply, action: { type } };
    if (type === 'browser_forward') return { say, expectReply, action: { type } };
    if (type === 'browser_reload') return { say, expectReply, action: { type } };
    if (type === 'focus_next_pane') return { say, expectReply, action: { type } };
    if (type === 'focus_previous_pane') return { say, expectReply, action: { type } };
    if (type === 'focus_pane' && typeof obj.action?.paneName === 'string') {
      return { say, expectReply, action: { type, paneName: obj.action.paneName } };
    }
    if (type === 'send_to_pane' && typeof obj.action?.text === 'string') {
      return { say, expectReply, action: { type, text: obj.action.text } };
    }
    if (type === 'run_command' && typeof obj.action?.command === 'string') {
      return { say, expectReply, action: { type, command: obj.action.command } };
    }
    if (type === 'mcp_tool' && typeof obj.action?.tool === 'string') {
      const args =
        obj.action.args && typeof obj.action.args === 'object' && !Array.isArray(obj.action.args)
          ? (obj.action.args as Record<string, unknown>)
          : {};
      return { say, expectReply, action: { type: 'mcp_tool', tool: obj.action.tool, args } };
    }
    return { say, expectReply, action: { type: 'none' } };
  } catch {
    return { say: raw.trim().slice(0, 300), action: { type: 'none' } };
  }
}

function firstAvailableAction(ctx: JarvisContext): string {
  if (ctx.focusedPaneKind === 'browser') return 'posso recarregar a página ou abrir outro site';
  if (ctx.focusedPaneKind === 'shell') return 'posso rodar um comando ou abrir outro terminal';
  if (ctx.orchestrator) return 'posso mandar uma missão para o squad ou focar outro pane';
  if (ctx.workspace) return 'posso abrir terminal, canvas, quadro ou configurações';
  return 'posso iniciar um workspace novo ou abrir configurações';
}

/**
 * LLM às vezes confirma em voz alta com action:none — nada executa no app.
 * Reaplica fast-path no transcript e heurísticas na fala antes de devolver.
 */
export function repairMissingAction(
  transcript: string,
  reply: JarvisReply,
  ctx: JarvisContext,
): JarvisReply {
  if (reply.action.type !== 'none') return reply;

  const actionFast = jarvisActionFastPath(transcript, ctx);
  if (actionFast) {
    return {
      ...actionFast,
      say: reply.say.trim() ? reply.say : actionFast.say,
      expectReply: actionFast.expectReply ?? false,
    };
  }

  const spoken = reply.say
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (
    /\b(terminal|shell|console)\b/.test(spoken) &&
    /\b(abr|abrindo|aberto|abri|pronto|criei)\b/.test(spoken)
  ) {
    return { ...reply, expectReply: false, action: { type: 'open_terminal' } };
  }

  return reply;
}

function localBrainFallbackReply(
  transcript: string,
  ctx: JarvisContext,
  hadProviderFailure: boolean,
): JarvisReply {
  const clean = transcript.trim();
  if (isLikelyNoiseTranscript(clean)) {
    return { say: '', expectReply: false, action: { type: 'none' } };
  }

  const user = ctx.userName?.trim();
  const address = user ? `${user}, ` : '';
  const suffix = firstAvailableAction(ctx);
  const prefix = hadProviderFailure
    ? 'tive uma falha rápida no cérebro online, mas continuo operando.'
    : 'estou aqui e continuo operando localmente.';

  return {
    say: `${address}${prefix} ${suffix}. O que quer que eu faça agora?`,
    expectReply: true,
    action: { type: 'none' },
  };
}

/**
 * Uma chamada de chat pela CADEIA de providers do cérebro (Gemini → OpenAI →
 * Groq, conforme configurado): tenta cada provider com key até um responder.
 * Consumidores fora da voz (squad-architect, harness-enrich) usam isto em vez
 * de reimplementar o loop de fallback.
 */
export async function chatViaBrainChain(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  deps: BrainDeps = defaultBrainDeps,
): Promise<string> {
  const attempts: string[] = [];
  for (const provider of flattenJarvisBrainProviders(getVoiceConfig().jarvisBrain)) {
    const key = providerKey(provider, deps);
    if (key === undefined) continue;
    try {
      return await chatOnce(
        provider.endpoint,
        key,
        provider.model,
        messages,
        deps,
        provider.jsonMode ?? true,
        maxTokens,
      );
    } catch (err) {
      attempts.push(
        `${provider.provider}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new Error(
    attempts[0] ??
      'nenhuma key de modelo (GEMINI_API_KEY, OPENAI_API_KEY ou GROQ_API_KEY)',
  );
}

/**
 * Deadline duro do cérebro: sem ele, um socket pendurado do provider segura o
 * turno inteiro (busy preso no renderer = "JARVIS não responde mais").
 */
export const BRAIN_TIMEOUT_MS = 15_000;

/**
 * Deadline da CADEIA inteira de providers. Fica ABAIXO do BRAIN_DEADLINE_MS do
 * renderer (35s): dois providers pendurando 15s cada somam 30s+, e o deadline
 * de fora cortaria ANTES de a JARVIS alcançar o fallback local gracioso — ela
 * ficaria muda. Correndo a cadeia contra este budget, o fallback vence a
 * corrida a tempo e NUNCA é pré-emptado pelo deadline externo (Gap 8).
 */
export const BRAIN_CHAIN_DEADLINE_MS = 28_000;

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
  let res: Response;
  try {
    res = await deps.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`timeout (${BRAIN_TIMEOUT_MS / 1000}s sem resposta)`);
    }
    throw err;
  }
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
  chainDeadlineMs = BRAIN_CHAIN_DEADLINE_MS,
): Promise<JarvisReply> {
  // Fast-path de ação: comando imperativo inequívoco executa sem LLM (~0ms).
  const actionFast = jarvisActionFastPath(transcript, ctx);
  if (actionFast) return actionFast;

  // Fast-path: consulta de estado responde do contexto em ~0ms, sem LLM.
  const fast = jarvisFastPath(transcript, ctx);
  if (fast) return fast;

  const facts = jarvisMemory.factsBlock();
  const voiceConfig = getVoiceConfig();
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Nexus MCP tools (use mcp_tool to invoke):\n${jarvisToolCatalogCompact()}` },
    { role: 'system', content: buildJarvisPersonaInstruction(voiceConfig.persona) },
    { role: 'system', content: contextBlock(ctx) },
    ...(facts
      ? [{ role: 'system', content: `Remembered facts (persistent memory):\n${facts}` }]
      : []),
    ...history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: transcript },
  ];

  const providers = flattenJarvisBrainProviders(voiceConfig.jarvisBrain);
  const attempts: string[] = [];

  const runChain = async (): Promise<JarvisReply> => {
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
          600,
        );
        applyMemoryOps(raw);
        return repairMissingAction(transcript, parseReply(raw), ctx);
      } catch (err) {
        attempts.push(
          `${provider.provider}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return attempts.length === 0
      ? localBrainFallbackReply(transcript, ctx, false)
      : localBrainFallbackReply(transcript, ctx, true);
  };

  // Gap 8: a cadeia corre contra um deadline PRÓPRIO (< BRAIN_DEADLINE_MS do
  // renderer). Se os providers pendurarem, o fallback local gracioso vence a
  // corrida a tempo — nunca é pré-emptado pelo deadline externo (que deixaria
  // a JARVIS muda com um erro em vez de "continuo operando localmente").
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<JarvisReply>((resolve) => {
    budgetTimer = setTimeout(
      () => resolve(localBrainFallbackReply(transcript, ctx, true)),
      chainDeadlineMs,
    );
  });
  try {
    return await Promise.race([runChain(), budget]);
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }
}
