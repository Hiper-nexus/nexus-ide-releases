export function normalizeVoiceCommand(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s._/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isContextReadOnly(t: string): boolean {
  return (
    /\b(qual|que|em que|onde)\b.*\b(pane|painel|terminal|aba)\b.*\b(focado|atual|selecionado|estou|estamos)\b/.test(
      t,
    ) ||
    /\b(qual|que|em que)\b.*\b(pagina|url|site)\b.*\b(atual|aberta|estou|estamos)\b/.test(t) ||
    /\b(onde estamos|onde eu estou|em que tela estamos|qual tela estou|qual tela estamos|onde estou no app)\b/.test(
      t,
    ) ||
    /\b(what|which)\b.*\b(pane|panel|terminal|tab)\b.*\b(focused|current|selected|on)\b/.test(t) ||
    /\b(what|which)\b.*\b(page|url|site)\b.*\b(current|open|on)\b/.test(t) ||
    /\b(where are we|where am i|what screen are we on|what screen am i on|current screen)\b/.test(
      t,
    )
  );
}

function isClockQuery(t: string): boolean {
  return /\b(que horas sao|hora certa|what time is it|current time)\b/.test(t);
}

export function shouldUseClassicActionBridge(transcript: string): boolean {
  const t = normalizeVoiceCommand(transcript);
  if (!t) return false;
  if (isContextReadOnly(t)) return false;
  return (
    isClockQuery(t) ||
    /\b(abre|abra|abrir|open|fecha|feche|fechar|close|cria|crie|criar|create|novo|nova|inicia|inicie|iniciar|start|sobe|suba|liga|ligue|monta|monte|montar|design|roda|rode|rodar|run|executa|execute|executar|manda|mande|mandar|send|envia|envie|enviar|corrige|corrija|conserta|conserte|implementa|implemente|edita|edite|salva|salve|instala|instale|mata|mate|para|pare|retoma|retome|foca|foque|focar|seleciona|selecione|selecionar|troca|troque|muda|mude|atualiza|atualize|sincroniza|sincronize|puxa|puxe|pull|vai|ir|focus|select|switch|go)\b/.test(
      t,
    ) ||
    /\b(terminal|shell|console|pane|painel|pagina|url|site|browser|canvas|workspace|projeto|squad|missao|missoes|orquestrador|board|quadro|git|github|origin|repositorio|repo|arquivo|pasta|comando|npm|teste|testes|build|status)\b/.test(
      t,
    )
  );
}

/**
 * When Gemini/OpenAI Live is hot, peer ADE keeps the provider as the sole
 * owner of the turn (tools + audio). Classic action-bridge must NOT interrupt
 * mid-speech — that was cutting "iniciar squad" before confirmation.
 *
 * Classic bridge remains only when Live is unavailable (degraded / classic transport).
 */
export function shouldLetRealtimeProviderAnswer(
  transcript: string,
  opts?: { isRealtimeLive?: boolean },
): boolean {
  if (opts?.isRealtimeLive === true) return true;
  return !shouldUseClassicActionBridge(transcript);
}
