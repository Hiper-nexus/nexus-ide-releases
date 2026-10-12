/**
 * Orquestração de "Atualizar tudo" (herdada do t3code UpdateEverything).
 *
 * Uma passada: providers CLIs primeiro (para não cortar um install no meio),
 * download do app em paralelo, e o install do app POR ÚLTIMO — o relançamento
 * encerra a corrida. Lógica pura: quem executa injeta os steps.
 */

export interface UpdateEverythingProvider {
  readonly adapterId: string;
  readonly label: string;
  /** CLI instalada que pode ser atualizada por receita. */
  readonly canUpdate: boolean;
}

export interface UpdateEverythingPlan {
  /** Versão do app disponível, ou null quando o app não atualiza. */
  readonly localVersion: string | null;
  /** CLIs que a passada vai atualizar. */
  readonly providers: ReadonlyArray<Pick<UpdateEverythingProvider, 'adapterId' | 'label'>>;
  /** Texto do tooltip/confirm: "app, 2 providers". */
  readonly summary: string;
  readonly hasWork: boolean;
}

export function planUpdateEverything(input: {
  readonly localVersion: string | null;
  readonly providers: readonly UpdateEverythingProvider[];
}): UpdateEverythingPlan {
  const providers = input.providers
    .filter((p) => p.canUpdate)
    .map((p) => ({ adapterId: p.adapterId, label: p.label }));
  const parts: string[] = [];
  if (input.localVersion) parts.push(`este app (${input.localVersion})`);
  if (providers.length === 1) parts.push(`1 provider (${providers[0]!.label})`);
  else if (providers.length > 1) parts.push(`${providers.length} providers`);
  return {
    localVersion: input.localVersion,
    providers,
    summary:
      parts.length === 0
        ? 'nada para atualizar'
        : parts.length === 1
          ? parts[0]!
          : `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}`,
    hasWork: Boolean(input.localVersion) || providers.length > 0,
  };
}

export interface UpdateEverythingSteps {
  /** Baixa o update do app. true quando pronto para instalar. */
  readonly downloadLocal?: () => Promise<boolean>;
  /** Atualiza todas as CLIs da passada (sequencial — não corta install). */
  readonly updateProviders: () => Promise<void>;
  /** Instala o update do app. O relançamento encerra a corrida. */
  readonly installLocal?: () => Promise<void>;
}

/**
 * Uma passada de "atualizar tudo". Providers terminam antes do install do
 * app; o download do app roda em paralelo com os providers. Download que
 * falha pula SÓ o install local.
 */
export async function runUpdateEverything(
  steps: UpdateEverythingSteps,
): Promise<void> {
  const [localReady] = await Promise.all([
    steps.downloadLocal?.() ?? Promise.resolve(true),
    steps.updateProviders(),
  ]);
  if (localReady) await steps.installLocal?.();
}

/** Linhas do diálogo: uma por alvo, app primeiro. */
export function updateEverythingLines(plan: UpdateEverythingPlan): string[] {
  const lines: string[] = [];
  if (plan.localVersion) lines.push(`NexusIDE → ${plan.localVersion}`);
  for (const p of plan.providers) lines.push(`${p.label} (${p.adapterId})`);
  return lines;
}
