import { isGitOperationalFailure, reportGitFailure } from './git-ipc-guard';

/**
 * Passo do boot que pode depender do git. Uma falha operacional do git
 * (prazo estourado, processo morto, spawn que não sobe) não pode impedir o app
 * de abrir: o passo é registrado no trace e o boot segue sem o resultado dele.
 * Qualquer outro erro continua propagando e cai no diálogo de inicialização.
 */
export function bootStep<T>(step: string, run: () => T): T | undefined {
  try {
    return run();
  } catch (error) {
    if (!isGitOperationalFailure(error)) throw error;
    reportGitFailure(`boot:${step}`, error);
    return undefined;
  }
}

export async function bootStepAsync<T>(
  step: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (!isGitOperationalFailure(error)) throw error;
    reportGitFailure(`boot:${step}`, error);
    return undefined;
  }
}

/** Resumo curto do erro que derrubou o boot, para o diálogo e o trace. */
export function describeBootFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 300);
  const code = (error as NodeJS.ErrnoException).code;
  const head = `${error.name}: ${error.message}`;
  return (code ? `${head} (${code})` : head).slice(0, 300);
}
