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
    .replace(/\b(workpasce|workspac|workpace|workbase|workspay)\b/g, 'workspace')
    .trim();
}

function stripTail(text: string): string {
  return text
    .replace(/\s+por favor$/i, '')
    .replace(/\s+please$/i, '')
    .replace(/\s+(agora|now)$/i, '')
    .trim();
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

  if (/\b(nova|novo|cria|crie|criar|abre|abra|abrir)\b.*\bmiss(ao|oes)\b/.test(t)) {
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
      expectReply: false,
      action: { type: 'design_squad' },
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

  if (
    /\b(?:inicia|inicie|iniciar|cria|crie|criar|abre|abra|abrir|comeca|comece|comecar)\b(?:\s+o)?\s+(?:um\s+)?(?:novo\s+|nova\s+)?(?:workspace|projeto|ambiente)\s*$/.test(
      t,
    ) ||
    /\b(?:novo|nova)\s+(?:workspace|projeto|ambiente)\b/.test(t) ||
    /\b(?:start|create|make|launch|initialize|init|begin)\b(?:\s+(?:a|an|one))?\s+(?:new\s+)?(?:workspace|project)\s*$/.test(
      t,
    ) ||
    /\bopen\b(?:\s+(?:a|an|one))?\s+new\s+(?:workspace|project)\s*$/.test(t) ||
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
