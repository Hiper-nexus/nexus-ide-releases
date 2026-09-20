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
  if (text.toLowerCase().startsWith(family.toLowerCase())) return text;
  return `${family} · ${text}`;
}
