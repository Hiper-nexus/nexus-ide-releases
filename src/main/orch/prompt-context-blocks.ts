/**
 * Ponto de montagem dos blocos de contexto do projeto no brief/primeiro
 * prompt dos panes (`<business-model>`, `<workspace-memory>`, …). Cada bloco
 * vem de uma função própria; aqui só se junta, na ordem dada, pulando vazio e
 * bloco que uma montagem anterior já pôs na FRENTE do prompt (re-spawn/resume
 * não duplica).
 */
import { UI_COMPOSITION_CONTEXT } from './ui-composition-policy';

export type PromptContextBlock = string | null | undefined;

function openingOf(block: string): string {
  return block.trimStart().split('\n', 1)[0]!;
}

/**
 * Aberturas dos blocos `<tag …>…</tag>` que abrem o texto, em sequência — o
 * que uma montagem anterior deixou. Só o cabeçalho conta: uma tarefa que cita
 * `<business-model fonte=…>` no meio do texto não suprime o bloco.
 */
function mountedBlocks(text: string): Array<{ opening: string; tag: string; content: string }> {
  const found: Array<{ opening: string; tag: string; content: string }> = [];
  let rest = text.trimStart();
  for (;;) {
    const opening = openingOf(rest);
    const tag = /^<([a-z][\w-]*)[\s>]/.exec(opening)?.[1];
    const close = tag ? rest.indexOf(`</${tag}>`) : -1;
    if (!tag || close < 0) return found;
    const end = close + tag.length + 3;
    found.push({ opening, tag, content: rest.slice(0, end) });
    rest = rest.slice(end).trimStart();
  }
}

/** Tags dos blocos de contexto que o próprio Nexus monta na frente do prompt. */
const NEXUS_CONTEXT_TAGS = new Set(['business-model', 'workspace-memory', 'nexus-ui-composition']);

/**
 * O texto depois dos blocos montados na frente: a tarefa, sem o contexto do
 * projeto. F-1362: só sai bloco que o Nexus monta. A remoção para no primeiro
 * `<task>`, `<instructions>` ou tag desconhecida, porque ali começa a tarefa.
 * A deduplicação continua reconhecendo qualquer tag. Só o baseline exato do
 * Nexus é contexto removível: uma tag forjada não pode esconder a tarefa.
 */
export function withoutMountedPromptContextBlocks(text: string): string {
  let rest = text.trimStart();
  for (const { opening, tag, content } of mountedBlocks(text)) {
    if (!NEXUS_CONTEXT_TAGS.has(tag) || !rest.startsWith(opening)) break;
    if (tag === 'nexus-ui-composition' && content !== UI_COMPOSITION_CONTEXT) break;
    rest = rest.slice(content.length).trimStart();
  }
  return rest;
}

/** Only leading mounted blocks count; mentioning a tag in the task is not injection. */
export function hasMountedPromptContextBlock(prompt: string, tag: string): boolean {
  return mountedBlocks(prompt).some((block) => block.tag === tag);
}

function freshBlocks(text: string, blocks: readonly PromptContextBlock[]): string[] {
  const mounted = mountedBlocks(text);
  return blocks.filter(
    (block): block is string => Boolean(block?.trim()) && !mounted.some((existing) =>
      block === UI_COMPOSITION_CONTEXT
        ? existing.content === UI_COMPOSITION_CONTEXT
        : existing.opening === openingOf(block!)),
  );
}

/** Blocos antes do prompt (contexto primeiro, tarefa depois). */
export function mountPromptContextBlocks(
  prompt: string,
  blocks: readonly PromptContextBlock[],
): string {
  const fresh = freshBlocks(prompt, blocks);
  return fresh.length > 0 ? `${fresh.join('\n\n')}\n\n${prompt}` : prompt;
}

export function withUiCompositionPolicy(prompt: string): string {
  return mountPromptContextBlocks(prompt, [UI_COMPOSITION_CONTEXT]);
}

/** Junta partes de um texto auxiliar (instructions do MCP, additionalContext). */
export function joinPromptContextBlocks(
  blocks: readonly PromptContextBlock[],
): string | undefined {
  const fresh = freshBlocks('', blocks);
  return fresh.length > 0 ? fresh.join('\n\n') : undefined;
}
