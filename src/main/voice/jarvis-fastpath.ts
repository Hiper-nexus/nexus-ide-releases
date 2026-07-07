import type { JarvisContext, JarvisReply } from '../../shared/voice-ipc';

/**
 * Fast-path do Jarvis: consultas de ESTADO respondem direto do contexto do
 * app, sem tocar no LLM — latência percebida cai de ~1s para ~0. Responder
 * "consultar/ler/navegar" sem passar pelo modelo é a maior alavanca individual
 * da sensação de "assistente vivo".
 *
 * Regra de ouro: SÓ perguntas de leitura inequívocas. Qualquer verbo de ação
 * ("abre", "roda", "cria"…) ou ambiguidade → null → o cérebro LLM decide.
 * Errar para o lado do LLM custa 1s; errar para o fast-path custa uma ação
 * não executada — por isso o guard vem primeiro.
 */

function norm(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ACTION_VERBS =
  /\b(abre|abra|abrir|roda|rode|rodar|executa|execute|executar|cria|crie|criar|manda|mande|mandar|envia|envie|enviar|fecha|feche|fechar|inicia|inicie|iniciar|comeca|comecar|monta|monte|montar|mata|matar|para|pare|parar|retoma|retome|deleta|delete|apaga|apague|troca|troque|muda|mude|escreve|escreva|digita|digite|instala|instale)\b/;

function listOrNone(items: string[], max = 5): string {
  if (items.length === 0) return '';
  const shown = items.slice(0, max).join(', ');
  const rest = items.length - max;
  return rest > 0 ? `${shown} e mais ${rest}` : shown;
}

function address(ctx: JarvisContext, text: string): string {
  const user = ctx.userName?.trim();
  if (!user) return text;
  return text.replace(/\.$/, `, ${user}.`);
}

function focusedPaneDescription(ctx: JarvisContext): string {
  if (!ctx.focusedPane) return 'Nenhum pane focado agora.';
  const kind =
    ctx.focusedPaneKind === 'browser'
      ? 'browser'
      : ctx.focusedPaneKind === 'shell'
        ? 'terminal'
        : ctx.focusedPaneKind === 'cli-agent'
          ? 'agente'
          : 'pane';
  const url =
    ctx.focusedPaneKind === 'browser' && ctx.focusedPaneUrl
      ? `, na página ${ctx.focusedPaneUrl}`
      : '';
  return `Pane focado: ${ctx.focusedPane} (${kind})${url}.`;
}

/** Tenta responder a consulta direto do contexto. null = deixa para o LLM. */
export function jarvisFastPath(
  transcript: string,
  ctx: JarvisContext,
): JarvisReply | null {
  const t = norm(transcript);
  if (!t || t.length > 90) return null;
  // Verbos de ação nunca entram no fast-path — mesmo em frases com cara de
  // pergunta ("abre o squad?" é um pedido, não uma consulta).
  if (ACTION_VERBS.test(t)) return null;

  // Que horas são?
  if (/\bque horas sao\b|\bme diz as horas\b|\bhora certa\b/.test(t)) {
    const time = new Date().toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return { say: address(ctx, `São ${time}.`), expectReply: false, action: { type: 'none' } };
  }

  // Panes/terminais abertos
  if (/\b(quais|que|quantos)\b.*\b(panes?|paines?|terminais|abas)\b/.test(t)) {
    const list = listOrNone(ctx.panes);
    return {
      say:
        ctx.panes.length === 0
          ? address(ctx, 'Nenhum pane aberto agora.')
          : address(ctx, `${ctx.panes.length} pane${ctx.panes.length > 1 ? 's' : ''}: ${list}.`),
      expectReply: false,
      action: { type: 'none' },
    };
  }

  // Pane/página/tela atual
  if (
    /\b(qual|que|em que|onde)\b.*\b(pane|painel|terminal|aba)\b.*\b(focado|atual|selecionado|estou|estamos)\b/.test(
      t,
    ) ||
    /\b(qual|que)\b.*\b(pagina|url|site)\b.*\b(atual|aberta|estou|estamos)\b/.test(t)
  ) {
    return {
      say: address(ctx, focusedPaneDescription(ctx)),
      expectReply: false,
      action: { type: 'none' },
    };
  }

  if (/\b(onde estamos|onde eu estou|em que tela estamos|qual tela estou|qual tela estamos)\b/.test(t)) {
    return {
      say: address(ctx, ctx.screen ?? focusedPaneDescription(ctx)),
      expectReply: false,
      action: { type: 'none' },
    };
  }

  // Squads disponíveis
  if (/\b(quais|que|quantos)\b.*\bsquads?\b/.test(t)) {
    const list = listOrNone(ctx.squads);
    return {
      say:
        ctx.squads.length === 0
          ? `${address(ctx, 'Nenhum squad salvo ainda.')} Quer que eu desenhe um para este projeto?`
          : address(ctx, `Squads disponíveis: ${list}.`),
      expectReply: ctx.squads.length === 0,
      action: { type: 'none' },
    };
  }

  // Missões ativas
  if (/\b(quais|que|quantas)\b.*\bmissoes\b/.test(t)) {
    const list = listOrNone(ctx.missions, 3);
    return {
      say:
        ctx.missions.length === 0
          ? address(ctx, 'Nenhuma missão ativa agora.')
          : address(ctx, `Missões ativas: ${list}.`),
      expectReply: false,
      action: { type: 'none' },
    };
  }

  // Workspace/projeto atual
  if (/\b(qual|que)\b.*\b(projeto|workspace)\b.*\b(aberto|atual|agora|esse)\b/.test(t)) {
    return {
      say: ctx.workspace
        ? address(ctx, `Estamos no ${ctx.workspace}.`)
        : address(ctx, 'Nenhum workspace aberto agora.'),
      expectReply: false,
      action: { type: 'none' },
    };
  }

  // Orquestrador ativo?
  if (/\borquestrador\b.*\b(ativo|rodando|ligado|tem|existe)\b|\b(tem|existe|ha)\b.*\borquestrador\b/.test(t)) {
    return {
      say: ctx.orchestrator
        ? address(ctx, `Sim — ${ctx.orchestrator} está de pé esperando missão.`)
        : address(ctx, 'Nenhum orquestrador ativo agora.'),
      expectReply: false,
      action: { type: 'none' },
    };
  }

  return null;
}
