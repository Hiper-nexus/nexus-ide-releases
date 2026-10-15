/**
 * Normaliza títulos de terminal escritos via OSC (0/2). Um CLI (Codex/Claude/
 * Grok) reescreve o título a cada frame do próprio spinner — "⠋ nexus-ide",
 * "◑ Brief…", "✳ …" — dezenas de vezes por segundo. Esta função remove o
 * glifo de status inicial e devolve a atividade que ele denotava separada do
 * texto, para quem grava o título (terminal-host) nunca propagar o glifo.
 *
 * Testes co-located: pane-title.test.ts
 */

import { familyFromAdapterId } from './pane-model-label';

export interface NormalizedPaneTitle {
  title: string;
  activity: 'busy' | 'idle' | null;
}

// Frames de spinner animado: braille (⠋⠙⠹⠸⠼⠴⠦⠧…, inclui ⠿), quartos de
// círculo (◐◑◒◓), a família de asteriscos que Codex/Claude/Grok usam para
// "trabalhando", e o `*` ASCII que o Claude Code põe na frente do OSC
// ("* Codex pane …" — F-597).
const BUSY_GLYPH = /^[⠀-⣿◐-◓✳✻✽✶✢*]/u;
// Ponto médio estático — CLI conectado, sem spinner animado (parado).
const IDLE_GLYPH = /^·/u;

export function normalizePaneTitle(raw: string): NormalizedPaneTitle {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return { title: '', activity: null };

  if (BUSY_GLYPH.test(collapsed)) {
    return { title: collapsed.slice(1).trim(), activity: 'busy' };
  }
  if (IDLE_GLYPH.test(collapsed)) {
    return { title: collapsed.slice(1).trim(), activity: 'idle' };
  }
  return { title: collapsed, activity: null };
}

// O ConPTY do Windows escreve sozinho o OSC 0/2 com o executável do console
// host anexado ("C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
// "C:\WINDOWS\system32\cmd.exe - agy.cmd"), ou o título padrão dele. Não é
// título de tarefa: vira lixo no cabeçalho ("AGY · C:\Wind…").
const ADMIN_PREFIX = /^administra(?:t|d)or:\s*/i;
const CONSOLE_HOST_PATH =
  /^((?:[a-z]:[\\/]|\\\\\?\\).*?)\.(?:exe|com|cmd|bat|ps1)(?:\s+-\s+.*)?$/i;
const CONSOLE_HOST_NAME =
  /^(?:windows powershell|prompt de comando|command prompt)$/i;

/**
 * Nome curto do console host do Windows ("powershell", "cmd") quando `title`
 * é o OSC automático do ConPTY; `null` para qualquer outro título.
 */
export function windowsConsoleHostName(title: string): string | null {
  const text = title.replace(ADMIN_PREFIX, '').trim();
  if (CONSOLE_HOST_NAME.test(text)) return text;
  const path = CONSOLE_HOST_PATH.exec(text)?.[1];
  return path === undefined ? null : (path.split(/[\\/]/).pop() ?? '');
}

export function isWindowsConsoleHostTitle(title: string): boolean {
  return windowsConsoleHostName(title) !== null;
}

/**
 * Identidade visível do pane de agente: a família da CLI (Claude/GPT/Grok…)
 * vem do adapterId despachado no spawn, nunca do texto OSC. Sem isso um
 * worker Claude cuja tarefa fala de Codex vira "Codex pane" no cabeçalho
 * enquanto o TUI é Sonnet (F-597).
 */
export function cliPaneDisplayTitle(
  adapterId: string | undefined,
  title: string,
): string {
  const family = adapterId ? familyFromAdapterId(adapterId) : null;
  const text = title.trim();
  if (!family) return text;
  if (!text) return family;
  const prefixed = text.toLowerCase().startsWith(family.toLowerCase());
  // Também limpa títulos já gravados no layout ("AGY · C:\Windows\…").
  const tail = prefixed
    ? text.slice(family.length).replace(/^\s*·\s*/, '')
    : text;
  if (isWindowsConsoleHostTitle(tail)) return family;
  return prefixed ? text : `${family} · ${text}`;
}
