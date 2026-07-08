export function normalizeVoiceCommand(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s._/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shouldUseClassicActionBridge(transcript: string): boolean {
  const t = normalizeVoiceCommand(transcript);
  if (!t) return false;
  return (
    /\b(abre|abra|abrir|open|fecha|feche|fechar|close|cria|crie|criar|create|novo|nova|inicia|inicie|iniciar|start|sobe|suba|liga|ligue|monta|monte|montar|design|roda|rode|rodar|run|executa|execute|executar|manda|mande|mandar|send|envia|envie|enviar|corrige|corrija|conserta|conserte|implementa|implemente|edita|edite|salva|salve|instala|instale|mata|mate|para|pare|retoma|retome|foca|foque|focar|seleciona|selecione|selecionar|troca|troque|muda|mude|vai|ir|focus|select|switch|go)\b/.test(
      t,
    ) ||
    /\b(terminal|shell|console|pane|painel|pagina|url|site|browser|canvas|workspace|projeto|squad|missao|missoes|orquestrador|board|quadro|git|arquivo|pasta|comando|npm|teste|testes|build|status)\b/.test(
      t,
    ) ||
    /\b(que horas sao|hora certa|onde estamos|onde eu estou|qual tela|qual pagina|qual pane)\b/.test(
      t,
    )
  );
}

export function shouldLetRealtimeProviderAnswer(transcript: string): boolean {
  return !shouldUseClassicActionBridge(transcript);
}
