/**
 * Locale UTF-8 garantido para o child PTY (bug F, 05/08).
 *
 * Um .app macOS lançado pelo Finder não herda LANG/LC_* do shell do usuário;
 * o allowlist de env só REPASSA o que existe, então o CLI filho rodava em
 * locale C e todo prompt pt-BR chegava como mojibake ("miss√£o", "n√£o",
 * "‚Äî" — bytes UTF-8 lidos como single-byte). Em dev o app nasce de um
 * terminal com locale herdado, por isso o defeito só aparecia empacotado.
 *
 * Regra: só corrige AUSÊNCIA ou C/POSIX; um locale UTF-8 legítimo do usuário
 * (LANG ou LC_ALL) nunca é sobrescrito. Windows fica fora — codepage não é
 * regida por LANG lá.
 */
const UTF8_FALLBACK_LOCALE = 'en_US.UTF-8';

function providesUtf8(value: string | undefined): boolean {
  return typeof value === 'string' && /utf-?8$/iu.test(value);
}

function isBrokenLocale(value: string | undefined): boolean {
  return value === undefined || value === 'C' || value === 'POSIX';
}

export function ensureUtf8Locale(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') return;
  if (providesUtf8(env.LC_ALL) || providesUtf8(env.LANG)) return;
  if (isBrokenLocale(env.LANG)) {
    env.LANG = UTF8_FALLBACK_LOCALE;
  }
}
