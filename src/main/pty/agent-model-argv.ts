/**
 * Resolução de modelo no spawn de agente.
 *
 * "Padrão da ferramenta" é uma escolha legítima do operador (e o único caminho
 * possível para CLI cujo catálogo o Nexus não conhece). Quando o modelo é
 * vazio, o template não pode deixar a flag órfã: `claude --model` sem valor
 * mata o pane no boot. Vazio = a CLI escolhe, e a flag some junto.
 */

/** Primeiro valor de fato preenchido — string vazia não é escolha de modelo. */
export function firstDeclaredModel(
  candidates: ReadonlyArray<string | undefined | null>,
): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return '';
}

/**
 * Template de spawn sem a flag de modelo quando não há modelo a passar.
 * Remove o placeholder e, junto, a flag que o precedia.
 */
export function interactiveTemplateForModel(
  interactive: readonly string[],
  modelFlag: string | undefined,
  model: string,
): string[] {
  if (model.trim().length > 0) return [...interactive];
  const argv: string[] = [];
  for (const arg of interactive) {
    if (arg.includes('{{MODEL}}')) {
      if (modelFlag && argv[argv.length - 1] === modelFlag) argv.pop();
      continue;
    }
    argv.push(arg);
  }
  return argv;
}

/**
 * O modelo pedido pelo spawn TEM de aparecer no argv. Sem a flag, Codex cai
 * no 5.5, DeepSeek no Flash, Claude no sonnet — exatamente o silêncio que o
 * operador proibiu.
 */
export function argvHonorsModel(
  args: readonly string[],
  modelFlag: string | undefined,
  model: string,
): boolean {
  const trimmed = model.trim();
  if (!trimmed) return true;
  if (!modelFlag?.trim()) return false;
  const flag = modelFlag.trim();
  if (flag.endsWith('=')) {
    return args.some((arg) => arg === `${flag}${trimmed}`);
  }
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] === trimmed;
}

export function sealedModelMissingFromArgvError(
  adapterLabel: string,
  model: string,
): Error {
  return new Error(
    `${adapterLabel}: modelo selado "${model}" não entrou no argv do spawn ` +
      '(a CLI cairia no default). Recusando em vez de silenciar.',
  );
}
