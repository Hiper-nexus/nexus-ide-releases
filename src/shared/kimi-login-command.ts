/**
 * Kimi login region selection.
 *
 * `kimi login --region global` opens kimi.ai (international, English OAuth
 * with Google etc.). `--region mainland-cn` opens kimi.com (Chinese auth page).
 *
 * Without the flag, the CLI auto-detects by IP/network and tends to land on
 * the mainland-cn page for users behind any CN-adjacent routing, making Google
 * login impossible (F-595: operator got Chinese page, could not authenticate).
 *
 * Policy: default to `global`. Only the mainland China locale (`zh_CN` /
 * `zh_Hans`) uses `mainland-cn`. `zh_TW` / `zh_HK` stay on global so the
 * suggested option is kimi.ai. The operator still picks the site at login
 * time (F-354): some clients use kimi.com.
 */

/** Visible for testing. */
export type KimiRegion = 'global' | 'mainland-cn';

export function kimiRegion(
  env: Readonly<Record<string, string | undefined>> = process.env,
): KimiRegion {
  const lang = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? '';
  return /^(zh[_-]CN|zh[_-]Hans)\b/i.test(lang) ? 'mainland-cn' : 'global';
}

export function kimiLoginCommandFor(region: KimiRegion): string {
  return `kimi login --region ${region}`;
}

export function kimiLoginCommand(
  env: Readonly<Record<string, string | undefined>> = process.env,
  region: KimiRegion = kimiRegion(env),
): string {
  return kimiLoginCommandFor(region);
}
