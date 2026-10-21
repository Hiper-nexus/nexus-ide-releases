/**
 * Vendor keys the OPERATOR bundles into Nexus itself (decision of 21/10/2026).
 *
 * This is the ONE deliberate exception to the repo's "no hardcoded secrets"
 * rule. The operator distributes Nexus to their own machines and clients and
 * wants both keys to work everywhere with zero setup: "ambos eu quero as key
 * deles dentro do nexus fixa, de forma que os clientes não consigam ler, mas o
 * sistema use elas". The earlier stance ("chave em bundle também não é
 * compartilhar, é publicar") was revisited with them and the vendor risk was
 * accepted — see the "Kits de UI" section in AGENTS.md.
 *
 * Shape of the exception:
 *
 * - Plain string constants compiled into the MAIN bundle. No keychain, no
 *   Windows registry, no env var, no file to read: the lookup is the same
 *   line of code on macOS, Windows and Linux, which is why it lives here and
 *   not in some platform store.
 * - MAIN PROCESS ONLY. Nothing here may be imported by the renderer or the
 *   preload bridge, may travel over IPC (masked tails only), may appear in
 *   argv (it shows in `ps`), or may be logged. A client using the app
 *   normally never sees a key; only someone unpacking the app bundle could,
 *   and that is the accepted risk above.
 * - LAST-resort fallback. Resolution order everywhere is the operator's own
 *   vault copy first, then their machine's environment, and only then these
 *   constants — so pasting a different key in Settings still wins.
 *
 * Rotation: edit the constant, ship a new Nexus. Nothing else to touch.
 */

/** BoardUI Pro licence key (one licence, activated per machine by the vendor). */
export const OPERATOR_BOARDUI_LICENSE_KEY = '4889238F-A27C-46BC-8D42-7C7AB11A636E';

/**
 * shadcn-CLI registry tokens, keyed by namespace. The URL each namespace must
 * be mapped to is NOT here — it stays in `KNOWN_UI_KIT_REGISTRIES`, and the
 * release path only hands a bundled token to the registry whose configured URL
 * is the vendor's own, so a client's settings cannot redirect this key to
 * another host.
 */
export const OPERATOR_REGISTRY_TOKENS: Readonly<Record<string, string>> = {
  '@shadcnuikit':
    'suk-i8PBpKLZRpYHaSg4KuPCHeE6otcMFFQQDdRV3AcbvdxPfa1VVexsCcFKoJC6KVR7om3fSKn',
};

/** The bundled token for a registry namespace, or null when we carry none. */
export function operatorRegistryToken(namespace: string): string | null {
  const value = OPERATOR_REGISTRY_TOKENS[namespace.trim()];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Namespaces a bundled token exists for. Order is the table's own. */
export function operatorRegistryNamespaces(): readonly string[] {
  return Object.keys(OPERATOR_REGISTRY_TOKENS);
}

/** Whether a BoardUI licence key ships with this build. */
export function hasOperatorBoardUiLicenseKey(): boolean {
  return OPERATOR_BOARDUI_LICENSE_KEY.trim().length > 0;
}
