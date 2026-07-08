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
  /\b(abre|abra|abrir|roda|rode|rodar|run|executa|execute|executar|cria|crie|criar|create|manda|mande|mandar|send|envia|envie|enviar|fecha|feche|fechar|close|inicia|inicie|iniciar|start|comeca|comecar|begin|monta|monte|montar|design|mata|matar|kill|para|pare|parar|stop|retoma|retome|resume|deleta|delete|apaga|apague|troca|troque|muda|mude|switch|focus|select|escreve|escreva|write|digita|digite|type|instala|instale|install)\b/;

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

function currentScreenDescription(ctx: JarvisContext): string {
  const screen = ctx.screen?.trim() ?? '';
  const normalized = screen.toLowerCase();
  if (normalized.includes('voice settings open')) {
    return 'Estou nas configurações de voz.';
  }
  if (normalized.includes('settings drawer open')) {
    return 'Estou nas configurações.';
  }
  const wizard = screen.match(/wizard open:\s*([^.;]+)/i);
  if (wizard?.[1]) {
    return `Estou no assistente de ${wizard[1].trim()}.`;
  }
  if (normalized.includes('home deck open')) {
    return ctx.workspace
      ? `Estou na tela Pronto para operar do ${ctx.workspace}.`
      : 'Estou na tela Pronto para operar.';
  }
  const file = screen.match(
    /files panel open on\s+(.+?)(?:\s+with unsaved changes|\. Workspace:|\. View:|\. Panes|\.$|$)/i,
  );
  if (file?.[1]) {
    return `Estou no painel de arquivos, no arquivo ${file[1].trim()}.`;
  }
  if (normalized.includes('files panel open')) {
    return 'Estou no painel de arquivos.';
  }
  if (normalized.includes('ops board open')) {
    return ctx.workspace
      ? `Estou no quadro de missões do ${ctx.workspace}.`
      : 'Estou no quadro de missões.';
  }
  if (normalized.includes('orchestration panel open')) {
    return 'Estou no painel de orquestração.';
  }
  if (screen && !normalized.startsWith('current nexus screen:')) return screen;
  const workspace = ctx.workspace ? `Workspace ${ctx.workspace}. ` : '';
  return `${workspace}${focusedPaneDescription(ctx)}`.trim();
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
  if (
    /\bque horas sao\b|\bme diz as horas\b|\bhora certa\b|\bwhat time is it\b|\bcurrent time\b/.test(
      t,
    )
  ) {
    const time = new Date().toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return { say: address(ctx, `São ${time}.`), expectReply: false, action: { type: 'none' } };
  }

  // Panes/terminais abertos
  if (
    /\b(quais|que|quantos)\b.*\b(panes?|paines?|terminais|abas)\b/.test(t) ||
    /\b(what|which|how many)\b.*\b(panes?|terminals?|tabs?)\b/.test(t) ||
    /\b(panes?|terminals?|tabs?)\b.*\b(open|running|active)\b/.test(t)
  ) {
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
    /\b(qual|que|em que)\b.*\b(pagina|url|site)\b.*\b(atual|aberta|estou|estamos)\b/.test(t) ||
    /\b(what|which)\b.*\b(pane|panel|terminal|tab)\b.*\b(focused|current|selected|on)\b/.test(t) ||
    /\b(what|which)\b.*\b(page|url|site)\b.*\b(current|open|on)\b/.test(t)
  ) {
    return {
      say: address(ctx, focusedPaneDescription(ctx)),
      expectReply: false,
      action: { type: 'none' },
    };
  }

  if (
    /\b(onde estamos|onde eu estou|em que tela estamos|qual tela estou|qual tela estamos|onde estou no app)\b/.test(
      t,
    ) ||
    /\b(where are we|where am i|what screen are we on|what screen am i on|current screen)\b/.test(
      t,
    )
  ) {
    return {
      say: address(ctx, currentScreenDescription(ctx)),
      expectReply: false,
      action: { type: 'none' },
    };
  }

  // Squads disponíveis
  if (
    /\b(quais|que|quantos)\b.*\bsquads?\b/.test(t) ||
    /\b(what|which|how many)\b.*\bsquads?\b/.test(t)
  ) {
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
  if (
    /\b(quais|que|quantas)\b.*\bmissoes\b/.test(t) ||
    /\b(what|which|how many)\b.*\b(missions?|tasks?)\b/.test(t)
  ) {
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
  if (
    /\b(qual|que)\b.*\b(projeto|workspace)\b.*\b(aberto|atual|agora|esse)\b/.test(t) ||
    /\b(what|which)\b.*\b(project|workspace)\b.*\b(open|current|on)\b/.test(t) ||
    /\bcurrent\s+(project|workspace)\b/.test(t)
  ) {
    return {
      say: ctx.workspace
        ? address(ctx, `Estamos no ${ctx.workspace}.`)
        : address(ctx, 'Nenhum workspace aberto agora.'),
      expectReply: false,
      action: { type: 'none' },
    };
  }

  // Orquestrador ativo?
  if (
    /\borquestrador\b.*\b(ativo|rodando|ligado|tem|existe)\b|\b(tem|existe|ha)\b.*\borquestrador\b/.test(
      t,
    ) ||
    /\borchestrator\b.*\b(active|running|online|present)\b|\b(is|any)\b.*\borchestrator\b/.test(
      t,
    )
  ) {
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
