/**
 * Ponto de montagem dos blocos de contexto do projeto no brief/primeiro
 * prompt dos panes (`<business-model>`, `<workspace-memory>`, …). Cada bloco
 * vem de uma função própria; aqui só se junta, na ordem dada, pulando vazio e
 * bloco cuja primeira linha o prompt já traz (re-spawn/resume não duplica).
 */
export type PromptContextBlock = string | null | undefined;

function freshBlocks(text: string, blocks: readonly PromptContextBlock[]): string[] {
  return blocks.filter((block): block is string => {
    if (!block?.trim()) return false;
    const opening = block.trimStart().split('\n', 1)[0]!;
    return !text.includes(opening);
  });
}

/** Blocos antes do prompt (contexto primeiro, tarefa depois). */
export function mountPromptContextBlocks(
  prompt: string,
  blocks: readonly PromptContextBlock[],
): string {
  const fresh = freshBlocks(prompt, blocks);
  return fresh.length > 0 ? `${fresh.join('\n\n')}\n\n${prompt}` : prompt;
}

/** Junta partes de um texto auxiliar (instructions do MCP, additionalContext). */
export function joinPromptContextBlocks(
  blocks: readonly PromptContextBlock[],
): string | undefined {
  const fresh = freshBlocks('', blocks);
  return fresh.length > 0 ? fresh.join('\n\n') : undefined;
}
