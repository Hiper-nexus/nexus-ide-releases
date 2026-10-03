/**
 * F-705: no AGY 1.2 o esforço mora no id do modelo (`gemini-3.8-flash-low`,
 * `-medium`, `-high`), e um `--effort` diferente do sufixo derruba o pane
 * na hora: `--model gemini-3.8-flash-low conflicts with --effort=medium`
 * (provado no 1.2.14; sufixo igual ao esforço passa). A rota escolhe modelo
 * e esforço separados — tabela por tier e esforço do Jev —, então o esforço
 * pedido escolhe a variante do MESMO modelo quando a CLI a lista. Sem a
 * variante, o id do modelo manda e o `--effort` sai do argv.
 */
const EFFORT_SUFFIX = /^(.+)-(low|medium|high)$/u;
const GEMINI_MODEL = /^gemini-/u;

export interface AgyModelEffort {
  readonly model: string;
  /** O `--effort` contradiria o sufixo e não tem variante: tirar do argv. */
  readonly dropEffort: boolean;
}

export function agyModelForEffort(
  model: string,
  effort: string | undefined,
  available: readonly string[],
): AgyModelEffort {
  const suffixed = EFFORT_SUFFIX.exec(model);
  const requested = effort?.trim();
  if (!requested) return { model, dropEffort: false };
  if (!suffixed) {
    // Gemini sem sufixo: a variante pedida entra se a CLI a lista; sem ela o
    // `--effort` sai. O AGY 1.2.16 recusa o par e o pane morre no boot:
    // `--effort is not supported for model "gemini-4-argon"` (F-773, 03/10).
    if (!GEMINI_MODEL.test(model)) return { model, dropEffort: false };
    const variant = `${model}-${requested}`;
    return available.includes(variant)
      ? { model: variant, dropEffort: false }
      : { model, dropEffort: true };
  }
  if (suffixed[2] === requested) return { model, dropEffort: false };
  const variant = `${suffixed[1]}-${requested}`;
  return available.includes(variant)
    ? { model: variant, dropEffort: false }
    : { model, dropEffort: true };
}

/** Tira o par `--effort <nível>` (ou `--effort=<nível>`) do argv. */
export function withoutEffortArg(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === flag) {
      index += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) continue;
    out.push(arg);
  }
  return out;
}
