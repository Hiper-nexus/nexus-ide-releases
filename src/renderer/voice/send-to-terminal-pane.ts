/**
 * Entrega de um comando a um terminal (shell) que o operador pediu pelo nome ou
 * número ("manda pro pane 2 rodar os testes"). Mesma disciplina do run_command:
 * UMA linha, e `confirmCommand` (só destrutivo/deploy/push remoto abre diálogo
 * nativo; o resto passa direto). Vive fora do executor para o ramo send_to_pane
 * continuar legível e o arquivo dentro do teto de linhas.
 */
import { waitForSession, writeToPane } from '../terminal/terminal-host';
import type { JarvisExecutionControl } from './jarvis-action-executor';
import { logVoiceEvent } from './voice-live-ipc';

export interface TerminalDelivery {
  /** Fala final: a falha/recusa substitui a corrente; o sucesso só preenche o vazio. */
  sayText: string;
  toolResult: {
    ok: boolean;
    summary: string;
    output?: { paneId: string; sessionReady: boolean };
  };
}

const SESSION_WAIT_MS = 750;

function throwIfAborted(control: JarvisExecutionControl): void {
  if (!control.signal?.aborted) return;
  const error = new Error('Jarvis action cancelled');
  error.name = 'AbortError';
  throw error;
}

export async function deliverCommandToTerminalPane(
  paneId: string,
  text: string,
  sayText: string,
  control: JarvisExecutionControl,
  reveal: (paneId: string) => void,
): Promise<TerminalDelivery> {
  const command = text.trim();
  if (!command || /[\r\n]/.test(command)) {
    return {
      sayText: 'Por segurança, eu só escrevo comandos de uma única linha em terminal.',
      toolResult: { ok: false, summary: 'comando multilinha ou vazio bloqueado' },
    };
  }
  const approved = await window.nexus.voice.confirmCommand(command);
  throwIfAborted(control);
  if (!approved) {
    return {
      sayText: 'Cancelei, não rodei o comando.',
      toolResult: { ok: false, summary: 'usuário recusou' },
    };
  }
  reveal(paneId);
  const sessionId = await waitForSession(paneId, SESSION_WAIT_MS);
  throwIfAborted(control);
  const ok = Boolean(sessionId) && writeToPane(paneId, `${command}\n`);
  if (ok) control.onEffectMayHaveCommitted?.();
  logVoiceEvent(
    ok ? 'info' : 'warn',
    ok ? 'pane.terminalCommandSubmitted' : 'pane.terminalCommandFailed',
    ok ? 'comando escrito no terminal pedido' : 'sessão do terminal indisponível',
    { paneId, chars: command.length, sessionReady: Boolean(sessionId) },
  );
  return {
    sayText: ok ? sayText || 'Comando enviado ao terminal.' : 'Não consegui escrever no terminal.',
    toolResult: {
      ok,
      summary: ok ? 'comando enviado ao terminal' : 'falha ao escrever no terminal',
      output: { paneId, sessionReady: Boolean(sessionId) },
    },
  };
}
