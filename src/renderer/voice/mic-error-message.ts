/**
 * Falha do getUserMedia em linguagem do operador.
 *
 * "Mic unavailable: Requested device not found" não diz o que fazer. No
 * Windows o app de desktop não recebe pedido de permissão: sem microfone
 * ativo no sistema (USB desconectado, P2 vazio) a captura só falha, e o
 * operador achava que o Nexus não tinha pedido permissão.
 */
export function micErrorMessage(err: unknown, platform: string): string {
  const name =
    err && typeof err === 'object' && 'name' in err
      ? String((err as { name?: unknown }).name)
      : '';
  const windows = platform === 'win32';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return windows
      ? 'Nenhum microfone ativo no Windows. Conecte o microfone e confira em Configurações › Sistema › Som › Entrada.'
      : 'Nenhum microfone encontrado. Conecte um microfone e tente de novo.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return windows
      ? 'O Windows bloqueou o microfone. Ative "Permitir que aplicativos da área de trabalho acessem o microfone" em Configurações › Privacidade e segurança › Microfone.'
      : 'O acesso ao microfone foi negado. Libere o Nexus nas permissões de microfone do sistema.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'O microfone está em uso por outro app ou travou. Feche o outro app ou reconecte o microfone.';
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `Microfone indisponível: ${detail}`;
}
