import type { JarvisContext, JarvisReply } from '../../shared/voice-ipc';

/**
 * Fast-path de AÇÕES: pedidos imperativos inequívocos executam sem LLM.
 * O cérebro Gemini/OpenAI às vezes responde em prosa ("vou abrir o terminal")
 * com action:none — o usuário ouve confirmação mas nada acontece. Este módulo
 * garante que comandos curtos e claros disparem a ação correta em ~0ms.
 */

function norm(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\bwork\s*space\b/g, 'workspace')
    .replace(/\bespaco\s+de\s+trabalho\b/g, 'workspace')
    .replace(/\b(workpasce|workspac|workpace|workbase|workspay|workspais|workispaco)\b/g, 'workspace')
    // STT often prefixes the command with the wake greeting itself.
    .replace(
      /^(?:e\s+ai|ei|oi|ola|hey)[,.]?\s*(?:jarvis|javes|jas|jarvs)?[,.?!]?\s*/i,
      '',
    )
    .replace(/[.!?,;:]+$/g, '')
    .trim();
}

function stripTail(text: string): string {
  return text
    .replace(/\s+por favor$/i, '')
    .replace(/\s+please$/i, '')
    .replace(/\s+(agora|now)$/i, '')
    .trim();
}

function looksLikeUrl(text: string): boolean {
  return /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#][^\s]*)?$/i.test(text.trim());
}

function normalizeUrl(text: string): string {
  const value = text.trim();
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function cleanPaneName(text: string): string {
  return stripTail(text)
    .replace(/^(?:o|a|os|as|the)\s+/i, '')
    .replace(/^(?:pane|painel|aba)\s+(?:de|do|da|chamado|chamada|called|named)\s+/i, '')
    .trim();
}

function agenticMissionIntent(text: string): string | undefined {
  const match = text.match(/\b(?:para|com\s+(?:o\s+)?objetivo(?:\s+de)?)\s+(.+)$/i);
  const intent = match ? stripTail(match[1]).slice(0, 4_000) : '';
  return intent || undefined;
}

function requestsCurrentViewRead(text: string): boolean {
  return (
    /\b(?:le|leia|ler|descreve|descreva|mostra|mostre)\b.*\b(?:esta|essa|a|aquela)\s+(?:tela|pagina|page|visao|view)\b/.test(
      text,
    ) ||
    /\b(?:o\s+que\s+(?:tem|ha|aparece|esta))\s+(?:aqui|nesta|nessa)\b/.test(text) ||
    /\b(?:o\s+que\s+(?:tem|ha|aparece|esta))\b.*\b(?:tela|pagina|page|visao|view)\b/.test(text)
  );
}

function say(ctx: JarvisContext, text: string): string {
  const user = ctx.userName?.trim();
  if (!user) return text;
  return text.replace(/\.$/, `, ${user}.`);
}

/** Tenta mapear um pedido de ação direto. null = deixa para o LLM. */
export function jarvisActionFastPath(
  transcript: string,
  ctx: JarvisContext,
): JarvisReply | null {
  const t = norm(transcript);
  if (!t || t.length > 120) return null;

  // An active squad/orchestrator changes the meaning of "continue a missão":
  // it is an instruction for that pane, never a request to create another
  // mission or redesign the squad. Route deterministically instead of leaving
  // this high-frequency command to free-form model tool selection.
  if (
    ctx.orchestrator &&
    /(?:\b(?:continua|continue|continuar|prossegue|prossiga|retoma|retome)\b.*\b(?:missao|squad|trabalho|tarefa)\b|\b(?:da|dar)\s+sequencia\b(?:.*\b(?:missao|squad|trabalho|tarefa)\b)?)/.test(t)
  ) {
    return {
      say: say(ctx, 'Dando sequência no squad.'),
      expectReply: false,
      action: {
        type: 'ask_pane',
        pergunta: 'Continue a missão atual a partir do ponto em que parou.',
      },
    };
  }

  if (
    /\b(abre|abra|abrir|novo|cria|crie|criar)\b.*\b(terminal|shell|console)\b/.test(t) ||
    /\b(terminal|shell)\b.*\b(novo|abrir|abre|abra)\b/.test(t)
  ) {
    return { say: say(ctx, 'Abrindo um terminal.'), expectReply: false, action: { type: 'open_terminal' } };
  }

  if (
    /\b(abre|abra|abrir|mostra|mostre)\b.*\b(board|quadro|painel de miss|ops board|missoes)\b/.test(t)
  ) {
    return { say: say(ctx, 'Abrindo o quadro de missões.'), expectReply: false, action: { type: 'open_board' } };
  }

  if (
    /\b(abre|abra|abrir|mostra|mostre|vai|ir)\b.*\b(configuracoes de voz|ajustes de voz|jarvis settings|voice settings)\b/.test(
      t,
    ) ||
    /\b(configuracoes de voz|ajustes de voz|voice settings)\b$/.test(t)
  ) {
    return {
      say: say(ctx, 'Abrindo as configurações de voz.'),
      expectReply: false,
      action: { type: 'open_voice_settings' },
    };
  }

  if (
    /\b(abre|abra|abrir|mostra|mostre|vai|ir)\b.*\b(configuracoes|ajustes|settings|preferencias)\b/.test(t) ||
    /\b(configuracoes|ajustes|settings|preferencias)\b$/.test(t)
  ) {
    return {
      say: say(ctx, 'Abrindo as configurações.'),
      expectReply: false,
      action: { type: 'open_settings' },
    };
  }

  if (
    /\b(abre|abra|abrir|mostra|mostre|ativa|ative|entrar|entra|vai|ir)\b.*\b(canvas|modo canvas|tela livre)\b/.test(
      t,
    ) ||
    /\b(modo canvas|canvas mode)\b$/.test(t)
  ) {
    return { say: say(ctx, 'Abrindo o canvas.'), expectReply: false, action: { type: 'open_canvas' } };
  }

  if (
    /\b(abre|abra|abrir|mostra|mostre|ativa|ative|volta|volte|vai|ir)\b.*\b(grid|grade|modo grade|modo grid)\b/.test(
      t,
    ) ||
    /\b(modo grade|modo grid|grid mode)\b$/.test(t)
  ) {
    return { say: say(ctx, 'Voltando para a grade.'), expectReply: false, action: { type: 'open_grid' } };
  }

  const openBrowserWithUrl = t.match(
    /\b(?:abre|abra|abrir|open)\b(?:\s+o)?\s+(?:site|url|pagina|page|browser|navegador)\s+(.+)$/,
  );
  if (openBrowserWithUrl) {
    const url = stripTail(openBrowserWithUrl[1]);
    if (looksLikeUrl(url)) {
      return {
        say: say(ctx, 'Abrindo o site.'),
        expectReply: false,
        action: { type: 'open_browser', url: normalizeUrl(url) },
      };
    }
  }

  if (
    /\b(?:abre|abra|abrir|open)\b(?:\s+o)?\s+(?:browser|navegador)\s*$/.test(t) ||
    /\b(?:browser|navegador)\s+(?:novo|new)\b/.test(t)
  ) {
    return {
      say: say(ctx, 'Abrindo o browser.'),
      expectReply: false,
      action: { type: 'open_browser' },
    };
  }

  if (/\b(?:volta|voltar|back)\b.*\b(?:pagina|site|browser|navegador)\b/.test(t)) {
    return {
      say: say(ctx, 'Voltando no browser.'),
      expectReply: false,
      action: { type: 'browser_back' },
    };
  }

  if (/\b(?:avanca|avancar|forward)\b.*\b(?:pagina|site|browser|navegador)\b/.test(t)) {
    return {
      say: say(ctx, 'Avançando no browser.'),
      expectReply: false,
      action: { type: 'browser_forward' },
    };
  }

  if (
    /\b(?:recarrega|recarregue|reload|atualiza|atualize)\b.*\b(?:pagina|site|browser|navegador)\b/.test(
      t,
    ) ||
    /\b(?:reload page|refresh page)\b/.test(t)
  ) {
    return {
      say: say(ctx, 'Recarregando a página.'),
      expectReply: false,
      action: { type: 'browser_reload' },
    };
  }

  if (
    (/\b(?:proximo|proxima|next)\b.*\b(?:pane|painel|aba|terminal)\b/.test(t) ||
      /\b(?:muda|troca|vai)\b.*\b(?:pane|painel|aba)\b/.test(t)) &&
    !/\b(?:anterior|previous)\b/.test(t)
  ) {
    return {
      say: say(ctx, 'Focando o próximo pane.'),
      expectReply: false,
      action: { type: 'focus_next_pane' },
    };
  }

  if (
    /\b(?:pane|painel|aba|terminal)\s+(?:anterior|previous)\b/.test(t) ||
    /\b(?:anterior|previous)\b.*\b(?:pane|painel|aba|terminal)\b/.test(t) ||
    /\b(?:volta|volte|back)\b.*\b(?:pane|painel|aba)\s+(?:anterior|previous)\b/.test(t)
  ) {
    return {
      say: say(ctx, 'Focando o pane anterior.'),
      expectReply: false,
      action: { type: 'focus_previous_pane' },
    };
  }

  const focusByKind =
    t.match(
      /\b(?:foca|foque|focar|seleciona|selecione|selecionar|vai|ir|troca|troque|muda|mude|mudar|focus|select|switch|go)\b.*\b(terminal|shell|browser|navegador|agente|agent|orquestrador|orchestrator)\b/,
    ) ??
    t.match(/\b(?:focus|select|switch to|go to)\s+(terminal|shell|browser|agent|orchestrator)\b/);
  if (focusByKind) {
    const paneName = cleanPaneName(focusByKind[1]);
    if (paneName) {
      return {
        say: say(ctx, `Focando ${paneName}.`),
        expectReply: false,
        action: { type: 'focus_pane', paneName },
      };
    }
  }

  const focusByName = t.match(
    /\b(?:foca|foque|focar|seleciona|selecione|selecionar|focus|select|switch to|go to)\b(?:\s+(?:o|a|the))?\s+(?:pane|painel|aba)\s+(.+)$/,
  );
  if (focusByName) {
    const paneName = cleanPaneName(focusByName[1]);
    if (paneName.length >= 2) {
      return {
        say: say(ctx, `Focando ${paneName}.`),
        expectReply: false,
        action: { type: 'focus_pane', paneName },
      };
    }
  }

  if (requestsCurrentViewRead(t)) {
    return {
      say: say(ctx, 'Vou ler o que está visível agora.'),
      expectReply: false,
      action: { type: 'read_current_view' },
    };
  }

  const requestsMission =
    /\b(nova|novo|cria|crie|criar|abre|abra|abrir|inicia|inicie|iniciar|comeca|comece|comecar)\b/.test(
      t,
    ) && /\bmiss(ao|oes)\b/.test(t);
  const requestsAgenticMode = /\b(?:modo\s+)?agentic(?:o|a)?\b/.test(t);
  if (requestsMission && requestsAgenticMode) {
    const intent = agenticMissionIntent(t);
    return {
      say: say(ctx, 'Abrindo a missão no modo agêntico.'),
      expectReply: false,
      action: { type: 'new_agentic_mission', ...(intent ? { intent } : {}) },
    };
  }

  if (/\b(nova|novo|cria|crie|criar|abre|abra|abrir|inicia|inicie|iniciar)\b.*\bmiss(ao|oes)\b/.test(t)) {
    return { say: say(ctx, 'Abrindo o assistente de missão.'), expectReply: false, action: { type: 'new_mission' } };
  }

  if (/\b(fecha|feche|fechar|fecha)\b.*\b(pane|terminal|aba|janela)\b/.test(t)) {
    return { say: say(ctx, 'Fechando o pane focado.'), expectReply: false, action: { type: 'close_pane' } };
  }

  if (
    /\b(monta|monte|montar|cria|crie|criar|design)\b.*\bsquad\b/.test(t) ||
    /\bsquad\b.*\b(custom|personalizado|projeto)\b/.test(t) ||
    /\b(?:inicia|inicie|iniciar|sobe|suba|liga|ligue)\b(?:\s+o)?\s+(?:um\s+)?(?:novo\s+)?squad\s*$/.test(t)
  ) {
    return {
      say: say(ctx, 'Vou montar um squad para este projeto.'),
      expectReply: true,
      action: { type: 'design_squad' },
    };
  }

  // Overclock wizard-fire: user confirms the open squad review ("sim", "inicia", …).
  if (
    /\brevis[aã]o de squad|squad pronto|iniciar squad\b/i.test(ctx.screen ?? '') &&
    /^(sim|confirma|confirmar|pode|pode iniciar|inicia|inicie|iniciar|dispara|dispare|vai|manda ver|ok|yes|go)\b/.test(
      t,
    )
  ) {
    return {
      say: say(ctx, 'Confirmado — iniciando o squad.'),
      expectReply: false,
      action: { type: 'confirm_squad' },
    };
  }

  const openSquad = t.match(
    /\b(?:abre|abra|abrir|sobe|suba|inicia|inicie|iniciar|liga|ligue|roda|rode)\b(?:\s+o)?\s+(?:um\s+)?(?:novo\s+)?squad(?:\s+(?:de|do|da))?\s+(.+)$/,
  );
  if (openSquad) {
    const squadName = stripTail(openSquad[1]);
    if (squadName.length >= 2) {
      return {
        say: say(ctx, `Subindo o squad ${squadName}.`),
        expectReply: false,
        action: { type: 'open_squad', squadName },
      };
    }
  }

  // STT variants: "abrir novo o workspace", "abre um novo workspace", …
  if (
    /\b(?:inicia|inicie|iniciar|cria|crie|criar|abre|abra|abrir|comeca|comece|comecar)\b\s+(?:no|na)\s+(?:workspace|projeto|ambiente)\s*$/.test(
      t,
    ) ||
    /\b(?:inicia|inicie|iniciar|cria|crie|criar|abre|abra|abrir|comeca|comece|comecar)\b(?:\s+(?:o|a|um|uma))?\s+(?:um\s+|uma\s+)?(?:novo\s+|nova\s+)?(?:(?:o|a|um|uma)\s+)?(?:workspace|projeto|ambiente)\b/.test(
      t,
    ) ||
    /\b(?:novo|nova)\s+(?:(?:o|a|um|uma)\s+)?(?:workspace|projeto|ambiente)\b/.test(t) ||
    /\b(?:start|create|make|launch|initialize|init|begin)\b(?:\s+(?:a|an|one))?\s+(?:new\s+)?(?:workspace|project)\b/.test(
      t,
    ) ||
    /\bopen\b(?:\s+(?:a|an|one))?\s+new\s+(?:workspace|project)\b/.test(t) ||
    /\bnew\s+(?:workspace|project)\b/.test(t)
  ) {
    return {
      say: say(ctx, 'Abrindo o assistente de novo workspace.'),
      expectReply: false,
      action: { type: 'new_workspace' },
    };
  }

  const openWs = t.match(
    /\b(?:abre|abra|abrir|inicia|inicie|iniciar|open)\b(?:\s+o)?\s+(?:projeto|project|workspace)\s+(.+)$/,
  );
  if (openWs) {
    const workspaceName = stripTail(openWs[1]);
    if (workspaceName.length >= 2) {
      return {
        say: say(ctx, `Abrindo ${workspaceName}.`),
        expectReply: false,
        action: { type: 'open_workspace', workspaceName },
      };
    }
  }

  const openCmd = t.match(/\babrir?\s+um\s+comando\s+(.+)$/);
  if (openCmd) {
    const command = stripTail(openCmd[1]);
    if (command.length >= 1) {
      return {
        say: say(ctx, `Rodando ${command}.`),
        expectReply: false,
        action: { type: 'run_command', command },
      };
    }
  }

  const runCmd = t.match(
    /\b(?:roda|rode|rodar|executa|execute|executar|corre|corra)\b(?:\s+o)?\s+(?:comando\s+)?(.+)$/,
  );
  if (runCmd) {
    const command = stripTail(runCmd[1].replace(/\s+no\s+terminal$/i, ''));
    if (command.length >= 1 && command.length <= 120) {
      return {
        say: say(ctx, `Rodando ${command}.`),
        expectReply: false,
        action: { type: 'run_command', command },
      };
    }
  }

  return null;
}
