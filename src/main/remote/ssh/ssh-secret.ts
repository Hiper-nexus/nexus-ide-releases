/** Senha só em memória. Nunca persistir o conteúdo — só o holder. */
export type SecretHolder = { value: string };

export function holdSecret(value: string): SecretHolder {
  return { value };
}

/** Sobrescreve e esvazia. Depois disto o holder não deve voltar a ser lido. */
export function wipeSecret(holder: SecretHolder | null | undefined): void {
  if (!holder) return;
  const length = holder.value.length;
  if (length > 0) {
    holder.value = '\0'.repeat(length);
  }
  holder.value = '';
}

export function takeSecret(holder: SecretHolder): string {
  const value = holder.value;
  wipeSecret(holder);
  return value;
}
