/**
 * F-1579: telas de Ajustes do sistema para o microfone e o som. O handler
 * antigo rodava `spawn("open", ["x-apple.systempreferences:…"])` em qualquer
 * sistema: no Windows o comando `open` não existe, os botões "Abrir
 * privacidade do mic", "Abrir som" e "Ajustes de som" não faziam nada, e o
 * `ENOENT` do spawn sem ouvinte de `error` era exceção sem dono no Main.
 *
 * Agora só abre URL de uma lista FECHADA (nada vem do renderer), pelo
 * `shell.openExternal`: o Electron entrega `x-apple.systempreferences:` ao
 * macOS e `ms-settings:` ao Windows. No Linux cada desktop tem os seus
 * Ajustes; não há URL comum — a interface esconde os botões.
 */

export type SystemSoundSettingsTarget = 'microphone' | 'sound';

const SETTINGS_URLS: Readonly<
  Partial<Record<NodeJS.Platform, Readonly<Record<SystemSoundSettingsTarget, string>>>>
> = {
  darwin: {
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    sound: 'x-apple.systempreferences:com.apple.preference.sound',
  },
  win32: {
    microphone: 'ms-settings:privacy-microphone',
    sound: 'ms-settings:sound',
  },
};

/** A URL fixa da tela pedida neste sistema, ou null quando não há. */
export function systemSoundSettingsUrl(
  target: SystemSoundSettingsTarget,
  platform: NodeJS.Platform,
): string | null {
  return SETTINGS_URLS[platform]?.[target] ?? null;
}

export interface OpenSystemSoundSettingsDeps {
  readonly platform: NodeJS.Platform;
  readonly openExternal: (url: string) => Promise<void>;
}

export type OpenSystemSoundSettingsResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'unsupported-platform' | 'open-failed' };

/** Abre a tela pedida; nunca lança (falha volta como motivo para o log). */
export async function openSystemSoundSettings(
  target: SystemSoundSettingsTarget,
  deps: OpenSystemSoundSettingsDeps,
): Promise<OpenSystemSoundSettingsResult> {
  const url = systemSoundSettingsUrl(target, deps.platform);
  if (!url) return { ok: false, reason: 'unsupported-platform' };
  try {
    await deps.openExternal(url);
    return { ok: true, url };
  } catch {
    return { ok: false, reason: 'open-failed' };
  }
}
