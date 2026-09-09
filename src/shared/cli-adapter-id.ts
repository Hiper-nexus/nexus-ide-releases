const LEGACY_CLI_ADAPTER_IDS: Readonly<Record<string, string>> = Object.freeze({
  gemini: 'agy',
  'gemini-cli': 'agy',
  'antigravity-cli': 'agy',
});

/**
 * Converte ids persistidos de CLIs removidas para o adapter que assumiu sua
 * função. Isso é somente migração de entrada; catálogos e seletores expõem
 * exclusivamente o id canônico.
 */
export function canonicalCliAdapterId(adapterId: string): string {
  const normalized = adapterId.trim().toLowerCase();
  return LEGACY_CLI_ADAPTER_IDS[normalized] ?? normalized;
}
