/**
 * Locale UTF-8 garantido para o child PTY (bug F, 05/08).
 *
 * Um .app macOS lançado pelo Finder não herda LANG/LC_* do shell do usuário;
 * o allowlist de env só REPASSA o que existe, então o CLI filho rodava em
 * locale C e todo prompt pt-BR chegava como mojibake ("miss√£o", "n√£o",
 * "‚Äî" — bytes UTF-8 lidos como single-byte). Em dev o app nasce de um
 * terminal com locale herdado, por isso o defeito só aparecia empacotado.
 *
 * Regra: só corrige AUSÊNCIA, C/POSIX ou UTF-8 INEXISTENTE no `locale -a`
 * (sufixo não é prova: en_BR.UTF-8 não existe); um locale UTF-8 instalado do
 * usuário (LANG ou LC_ALL) nunca é sobrescrito. Sem como verificar
 * (fail-open), confia no herdado. No Windows o codepage do cmd não segue
 * LANG, mas o Git Bash sim: sem LANG ele conta ${#texto} em bytes e um
 * script com `set -u` morre ao indexar um array pelo tamanho do banner
 * (ai-launcher: BANNER_GRAD[i] unbound). Lá o fallback é C.UTF-8, sem
 * consultar `locale -a`.
 */
import { execFileSync } from 'node:child_process';

const UTF8_FALLBACK_LOCALE = 'en_US.UTF-8';

function providesUtf8(value: string | undefined): boolean {
  return typeof value === 'string' && /utf-?8$/iu.test(value);
}

function isBrokenLocale(value: string | undefined): boolean {
  return value === undefined || value === 'C' || value === 'POSIX';
}

/** Precedência POSIX de charset: LC_ALL > LC_CTYPE > LANG. */
const LOCALE_OVERRIDES = ['LC_ALL', 'LC_CTYPE'] as const;

export interface Utf8LocaleAvailability {
  /**
   * Lista nomes de `locale -a`. null = sem como verificar (fail-open:
   * confia no herdado, como antes). Injetável para teste hermético.
   */
  readonly listLocales?: () => readonly string[] | null;
}

let cachedAvailableLocales: readonly string[] | null | undefined;

function availableLocales(
  deps?: Utf8LocaleAvailability,
): readonly string[] | null {
  if (deps?.listLocales) {
    try {
      return deps.listLocales();
    } catch {
      return null;
    }
  }
  if (cachedAvailableLocales !== undefined) return cachedAvailableLocales;
  try {
    const out = execFileSync('locale', ['-a'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cachedAvailableLocales = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    cachedAvailableLocales = null;
  }
  return cachedAvailableLocales;
}

function localeInstalled(
  name: string,
  available: readonly string[] | null,
): boolean {
  // Sem como verificar, confia — nunca travar spawn por causa de locale.
  if (!available) return true;
  const norm = (s: string): string => s.toLowerCase().replace(/-/g, '');
  const want = norm(name);
  return available.some((candidate) => norm(candidate) === want);
}

export function ensureUtf8Locale(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  deps?: Utf8LocaleAvailability,
): void {
  if (platform === 'win32') {
    for (const key of LOCALE_OVERRIDES) {
      if (env[key] !== undefined && isBrokenLocale(env[key])) delete env[key];
    }
    if (
      providesUtf8(env.LC_ALL) ||
      providesUtf8(env.LC_CTYPE) ||
      providesUtf8(env.LANG)
    ) {
      return;
    }
    if (isBrokenLocale(env.LANG)) env.LANG = 'C.UTF-8';
    return;
  }

  // Sufixo UTF-8 não é prova: en_BR.UTF-8 (idioma en + região BR) termina
  // assim e não existe em `locale -a` — todo filho cuspia warnings de perl.
  // Valor inexistente é descartado aqui e o fallback abaixo assume. Sem
  // nenhum UTF-8 herdado, nem consulta o sistema (spawn do Finder continua
  // barato e determinístico).
  const inheritedUtf8 = (['LANG', 'LC_ALL', 'LC_CTYPE'] as const).some((key) =>
    providesUtf8(env[key]),
  );
  const available = inheritedUtf8 ? availableLocales(deps) : null;
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE'] as const) {
    const value = env[key];
    if (
      value &&
      providesUtf8(value) &&
      !localeInstalled(value, available)
    ) {
      delete env[key];
    }
  }
  // Um C/POSIX acima do LANG derruba qualquer LANG UTF-8 — injetar LANG não
  // salvaria nada e o prompt pt-BR voltaria como "n√£o". Remover a variável
  // quebrada devolve a decisão ao LANG, que o passo seguinte garante UTF-8.
  for (const key of LOCALE_OVERRIDES) {
    if (env[key] !== undefined && isBrokenLocale(env[key])) delete env[key];
  }
  if (
    providesUtf8(env.LC_ALL) ||
    providesUtf8(env.LC_CTYPE) ||
    providesUtf8(env.LANG)
  ) {
    return;
  }
  if (isBrokenLocale(env.LANG)) {
    env.LANG = UTF8_FALLBACK_LOCALE;
  }
}
