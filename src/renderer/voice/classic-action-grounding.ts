import type { JarvisAction } from '../../shared/voice-ipc';
import { normalizeVoiceCommand, shouldUseClassicActionBridge } from './realtime-bridge-policy';

const TARGETS: Partial<Record<JarvisAction['type'], RegExp>> = {
  open_terminal: /\b(terminal|shell|console)\b/,
  open_workspace: /\b(workspace|projeto|project)\b/,
  new_workspace: /\b(workspace|projeto|project)\b/,
  open_squad: /\b(squad|equipe|team)\b/,
  open_squad_picker: /\b(squad|equipe|team)\b/,
  design_squad: /\b(squad|equipe|team)\b/,
  confirm_squad: /\b(squad|equipe|team)\b/,
  new_mission: /\b(missao|mission)\b/,
  new_agentic_mission: /\b(missao|mission|agentic|agentico)\b/,
  open_board: /\b(board|quadro|missoes|missions)\b/,
  open_settings: /\b(configuracoes|ajustes|settings|preferencias)\b/,
  open_voice_settings: /\b(voz|voice|jarvis|microfone|mic)\b/,
  open_canvas: /\b(canvas|tela livre)\b/,
  open_grid: /\b(grid|grade)\b/,
  open_browser: /\b(browser|navegador|site|url|pagina|page)\b/,
  close_pane: /\b(pane|painel|aba|terminal)\b/,
  focus_pane: /\b(pane|painel|aba|terminal|agente|agent)\b/,
  focus_next_pane: /\b(pane|painel|aba|terminal)\b/,
  focus_previous_pane: /\b(pane|painel|aba|terminal)\b/,
  read_pane: /\b(pane|painel|terminal|agente|agent)\b/,
  read_current_view: /\b(tela|pagina|page|visao|view|aqui)\b/,
  restore_mission_panes: /\b(restaur|reabr|pane|missao|mission)\w*\b/,
  sync_repo_via_pane:
    /\b(git|repositorio|repo|pull|push|fetch|sincroniz|atualiz.*\b(repo|repositorio|codigo|branch|main|master)|status\s+do\s+git)\b/,
};

/**
 * Classic is a degraded LLM path, never an authority source. A mutating or UI
 * action must be grounded both in an operational utterance and in the target
 * named by that utterance. This blocks model-added actions such as opening a
 * terminal after ambient speech saying only "vamos ao vivo".
 */
export function isClassicActionGrounded(transcript: string, action: JarvisAction): boolean {
  if (action.type === 'none') return true;
  const normalized = normalizeVoiceCommand(transcript);
  if (!shouldUseClassicActionBridge(normalized)) return false;
  const target = TARGETS[action.type];
  if (target && !target.test(normalized)) return false;
  return true;
}
