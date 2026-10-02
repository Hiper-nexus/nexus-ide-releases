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
 */

export const LINUX_PASSWORD_STORE_SWITCH = 'password-store';
export const LINUX_LIBSECRET_STORE = 'gnome-libsecret';

export interface LinuxSecretStoreContext {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** O operador já escolheu um backend na linha de comando. */
  hasExplicitStore: boolean;
  /** Smoke/harness: nunca falar com o keyring de quem roda o teste. */
  automatedTest: boolean;
}

function isKdeSession(env: Readonly<Record<string, string | undefined>>): boolean {
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .map((token) => token.trim().toLowerCase());
  return desktops.includes('kde') || env.KDE_FULL_SESSION === 'true';
}

/** PURO: o backend a forçar, ou `null` para deixar a detecção do Chromium. */
export function linuxPasswordStoreOverride(context: LinuxSecretStoreContext): string | null {
  if (context.platform !== 'linux') return null;
  if (context.automatedTest || context.hasExplicitStore) return null;
  // No KDE a detecção nativa escolhe o KWallet da versão certa (5 ou 6).
  if (isKdeSession(context.env)) return null;
  return LINUX_LIBSECRET_STORE;
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
