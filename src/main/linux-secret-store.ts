/**
 * Cofre de segredos no Linux fora de GNOME/KDE.
 *
 * O Chromium escolhe o backend do `safeStorage` pelo `XDG_CURRENT_DESKTOP`:
 * KDE → KWallet; GNOME, Unity, Cinnamon, XFCE… → libsecret; QUALQUER outro
 * desktop (Hyprland/Omarchy, sway, niri, i3, LXQt, sessão sem a variável) →
 * `basic_text`, que não cifra nada. O `secrets-store` recusa `basic_text` de
 * propósito (fail closed), então nesses desktops o cofre ficava desligado: o
 * login não tinha onde guardar a sessão e nenhuma chave de provider era salva
 * — mesmo com um Secret Service (gnome-keyring, KeePassXC) rodando.
 *
 * Medido no Omarchy/Hyprland 0.56 com gnome-keyring ativo (02/10):
 *   sem o switch  → backend `basic_text`,     isEncryptionAvailable() = false
 *   com o switch  → backend `gnome_libsecret`, cifra e decifra (prefixo v11)
 *
 * A correção só ESCOLHE o backend; a recusa do `basic_text` continua valendo.
 * Sem Secret Service o libsecret falha e o cofre segue indisponível, como
 * antes — nunca degrada para texto plano.
 *
 * A decisão vem do port do T3 Code (`linux-secret-storage.ts`): só um literal
 * EXATO do `XDG_CURRENT_DESKTOP` que o Chromium reconhece (KDE, GNOME, XFCE…)
 * deixa a detecção nativa agir. `KDE_FULL_SESSION`/`DESKTOP_SESSION` são
 * restos de sessão — sway/Hyprland abertos de um login KDE herdam
 * `KDE_FULL_SESSION=true` e antes caíam em `basic_text` com o cofre
 * desligado. LXQt é reconhecido pelo Chromium e mesmo assim vai a
 * `basic_text`, então também é forçado. Quem precisa de uma geração de
 * KWallet escolhe com `NEXUS_LINUX_PASSWORD_STORE=kwallet5|kwallet6|kwallet|
 * gnome-libsecret` (ou com `--password-store`, que tem precedência).
 */

import {
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  type LinuxPasswordStoreSwitch,
} from './linux-secret-storage';

export const LINUX_PASSWORD_STORE_SWITCH = 'password-store';
/** Preferência explícita do operador, lida antes do `ready` (sem settings ainda). */
export const LINUX_PASSWORD_STORE_ENV = 'NEXUS_LINUX_PASSWORD_STORE';

export interface LinuxSecretStoreContext {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** O operador já escolheu um backend na linha de comando. */
  hasExplicitStore: boolean;
  /** Smoke/harness: nunca falar com o keyring de quem roda o teste. */
  automatedTest: boolean;
}

/** PURO: o backend a forçar, ou `null` para deixar a detecção do Chromium. */
export function linuxPasswordStoreOverride(
  context: LinuxSecretStoreContext,
): LinuxPasswordStoreSwitch | null {
  if (context.platform !== 'linux') return null;
  if (context.automatedTest || context.hasExplicitStore) return null;
  // No KDE canônico (literal exato) a detecção nativa escolhe o KWallet da
  // versão certa (5 ou 6); nos demais desktops o resultado é gnome-libsecret.
  return resolveLinuxPasswordStoreSwitch({
    preference: normalizeLinuxPasswordStorePreference(
      context.env[LINUX_PASSWORD_STORE_ENV]?.trim(),
    ),
    env: context.env,
  });
}

interface CommandLineLike {
  hasSwitch(name: string): boolean;
  appendSwitch(name: string, value?: string): void;
}

/**
 * Borda. Precisa rodar ANTES do `ready`: o Chromium lê o switch ao montar o
 * OSCrypt, logo depois do script principal.
 */
export function configureLinuxSecretStore(
  commandLine: CommandLineLike,
  context: Omit<LinuxSecretStoreContext, 'hasExplicitStore'>,
): string | null {
  const store = linuxPasswordStoreOverride({
    ...context,
    hasExplicitStore: commandLine.hasSwitch(LINUX_PASSWORD_STORE_SWITCH),
  });
  if (store) commandLine.appendSwitch(LINUX_PASSWORD_STORE_SWITCH, store);
  return store;
}
