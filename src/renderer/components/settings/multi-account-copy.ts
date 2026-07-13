/**
 * Copy puro do bloco multi-conta (Contas e login).
 * Independente do adapter: a mesma lógica vale para Claude, Codex, AGY, Grok,
 * Kimi, OpenCode, GLM, LongCat, Aider… — só muda o `adapterLabel` nas frases.
 */

export interface MultiAccountAddCopy {
  /** Ex.: "Adicionar a 2ª conta" */
  title: string;
  sub: string;
  /** Ordem operacional da próxima entrada (1, 2, 3…). */
  nextOrdinal: number;
  chip: string;
  chipOn: boolean;
  chipTitle: string;
}

/**
 * Em uso (vault ativa OU sessão nativa/API key ok) conta como 1ª conta.
 * Vault vazio + em uso ⇒ próximo add é a 2ª — nunca "1ª".
 */
export function multiAccountAddCopy(input: {
  vaultCount: number;
  standbyCount: number;
  hasEmUso: boolean;
}): MultiAccountAddCopy {
  const vault = Math.max(0, Math.floor(input.vaultCount));
  const standby = Math.max(0, Math.floor(input.standbyCount));
  const { hasEmUso } = input;

  const nextOrdinal =
    vault === 0 && hasEmUso ? 2 : vault === 0 ? 1 : vault + 1;

  const title =
    nextOrdinal === 1
      ? 'Adicionar a 1ª conta'
      : `Adicionar a ${nextOrdinal}ª conta`;

  let sub: string;
  if (vault === 0 && hasEmUso) {
    sub =
      'A sessão em uso já é a 1ª. Grave outra assinatura ou API key no vault como reserva (2ª, 3ª…).';
  } else if (vault === 0) {
    sub =
      'Primeira entrada no vault deste provider. Depois pode repetir para multi-conta.';
  } else {
    const reserve =
      standby > 0 ? ` (${standby} reserva)` : '';
    sub = `Já há ${vault} no vault${reserve}. Cada nova entrada vira mais um slot para failover.`;
  }

  // Failover real: ≥2 no vault. "Em uso + 1 vault" já é multi-path.
  const chipOn = vault >= 2 || (hasEmUso && vault >= 1);
  let chip: string;
  let chipTitle: string;
  if (vault >= 2) {
    chip = `Multi-conta · ${vault}`;
    chipTitle = `${vault} contas no vault — failover e troca manual ativos`;
  } else if (hasEmUso && vault === 0) {
    chip = 'Multi-conta · falta reserva';
    chipTitle =
      'Sessão em uso conta como 1ª. Adicione a 2ª conta ao vault para failover';
  } else if (vault === 1) {
    chip = 'Multi-conta · falta reserva';
    chipTitle = '1 conta no vault. Adicione outra para failover automático';
  } else {
    chip = 'Multi-conta';
    chipTitle =
      'Adicione 2 ou mais contas no vault para multi-conta e failover';
  }

  return { title, sub, nextOrdinal, chip, chipOn, chipTitle };
}

export function sessionChoiceBlurb(input: {
  adapterLabel: string;
  hasEmUso: boolean;
  vaultCount: number;
}): string {
  const name = input.adapterLabel.trim() || 'esta CLI';
  if (input.hasEmUso && input.vaultCount === 0) {
    return `Guarda o login de ${name} no vault como 2ª conta (ou troca de conta no CLI e salva de novo)`;
  }
  return `Grava o login atual de ${name} no vault — sem re-login no hot-swap`;
}

export function apiKeyChoiceBlurb(input: {
  hasEmUso: boolean;
  vaultCount: number;
}): string {
  if (input.hasEmUso && input.vaultCount === 0) {
    return '2ª conta via key nativa ou upstream (GLM, OpenRouter…)';
  }
  return 'Conta via key nativa ou upstream (GLM, OpenRouter…)';
}

/** Builtin CLI adapters that must share this multi-conta UX. */
export const ALL_MULTI_ACCOUNT_ADAPTER_IDS = [
  'claude',
  'codex',
  'agy',
  'grok',
  'kimi',
  'opencode',
  'glm',
  'longcat',
  'aider',
] as const;

export type MultiAccountAdapterId =
  (typeof ALL_MULTI_ACCOUNT_ADAPTER_IDS)[number];
