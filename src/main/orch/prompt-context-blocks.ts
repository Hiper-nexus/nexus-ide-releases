/**
 * Ponto de montagem dos blocos de contexto do projeto no brief/primeiro
 * prompt dos panes (`<business-model>`, `<workspace-memory>`, …). Cada bloco
 * vem de uma função própria; aqui só se junta, na ordem dada, pulando vazio e
 * bloco que uma montagem anterior já pôs na FRENTE do prompt (re-spawn/resume
 * não duplica).
 */
export type PromptContextBlock = string | null | undefined;

function openingOf(block: string): string {
  return block.trimStart().split('\n', 1)[0]!;
}

/**
 * Aberturas dos blocos `<tag …>…</tag>` que abrem o texto, em sequência — o
 * que uma montagem anterior deixou. Só o cabeçalho conta: uma tarefa que cita
 * `<business-model fonte=…>` no meio do texto não suprime o bloco.
 */
function mountedOpenings(text: string): Set<string> {
  const found = new Set<string>();
  let rest = text.trimStart();
  for (;;) {
    const opening = openingOf(rest);
    const tag = /^<([a-z][\w-]*)[\s>]/.exec(opening)?.[1];
    const close = tag ? rest.indexOf(`</${tag}>`) : -1;
    if (!tag || close < 0) return found;
    found.add(opening);
    rest = rest.slice(close + tag.length + 3).trimStart();
  }
}

/** O texto depois dos blocos montados na frente: a tarefa, sem o contexto do projeto. */
export function withoutMountedPromptContextBlocks(text: string): string {
  let rest = text.trimStart();
  for (const opening of mountedOpenings(text)) {
    const tag = /^<([a-z][\w-]*)[\s>]/.exec(opening)![1];
    if (!rest.startsWith(opening)) break;
    rest = rest.slice(rest.indexOf(`</${tag}>`) + tag.length + 3).trimStart();
  }
  return rest;
}

/** Only leading mounted blocks count; mentioning a tag in the task is not injection. */
export function hasMountedPromptContextBlock(prompt: string, tag: string): boolean {
  return [...mountedOpenings(prompt)].some(
    (opening) => /^<([a-z][\w-]*)[\s>]/.exec(opening)?.[1] === tag,
  );
}

function freshBlocks(text: string, blocks: readonly PromptContextBlock[]): string[] {
  const mounted = mountedOpenings(text);
  return blocks.filter(
    (block): block is string => Boolean(block?.trim()) && !mounted.has(openingOf(block!)),
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

/** Junta partes de um texto auxiliar (instructions do MCP, additionalContext). */
export function joinPromptContextBlocks(
  blocks: readonly PromptContextBlock[],
): string | undefined {
  const fresh = freshBlocks('', blocks);
  return fresh.length > 0 ? fresh.join('\n\n') : undefined;
}
