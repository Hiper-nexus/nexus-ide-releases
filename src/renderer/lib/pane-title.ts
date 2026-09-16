/**
 * Normaliza títulos de terminal escritos via OSC (0/2). Um CLI (Codex/Claude/
 * Grok) reescreve o título a cada frame do próprio spinner — "⠋ nexus-ide",
 * "◑ Brief…", "✳ …" — dezenas de vezes por segundo. Esta função remove o
 * glifo de status inicial e devolve a atividade que ele denotava separada do
 * texto, para quem grava o título (terminal-host) nunca propagar o glifo.
 *
 * Testes co-located: pane-title.test.ts
 */

export interface NormalizedPaneTitle {
  title: string;
  activity: 'busy' | 'idle' | null;
}

// Frames de spinner animado: braille (⠋⠙⠹⠸⠼⠴⠦⠧…, inclui ⠿), quartos de
// círculo (◐◑◒◓) e a família de asteriscos que Codex/Claude/Grok usam para
// "trabalhando".
const BUSY_GLYPH = /^[⠀-⣿◐-◓✳✻✽✶✢]/u;
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
