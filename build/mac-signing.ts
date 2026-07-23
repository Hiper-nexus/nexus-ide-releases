const APP_ENTITLEMENTS_PATH = 'build/entitlements.mac.plist';
const HELPER_ENTITLEMENTS_PATH = 'build/entitlements.mac.helper.plist';
const RENDERER_ENTITLEMENTS_PATH = 'build/entitlements.mac.renderer.plist';
const PLUGIN_ENTITLEMENTS_PATH = 'build/entitlements.mac.plugin.plist';
const EMPTY_ENTITLEMENTS_PATH = 'build/entitlements.mac.none.plist';

export const EXPECTED_DEVELOPER_ID_IDENTITY =
  'Developer ID Application: Cleofas Pereira rocha';
export const EXPECTED_APPLE_TEAM_ID = '35P5XL3JN6';
export const EXPECTED_NOTARY_PROFILE = 'nexus-notary';

const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

function isBundleOrExecutable(filePath: string, bundleName: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').replace(/\/$/u, '');
  const executableName = bundleName.slice(0, -'.app'.length);
  return (
    normalized === bundleName ||
    normalized.endsWith(`/${bundleName}`) ||
    normalized.endsWith(
      `/${bundleName}/Contents/MacOS/${executableName}`,
    )
  );
}

/**
 * @electron/osx-sign calls optionsForFile for bundle containers, executables,
 * frameworks and native modules. Only Electron/V8 executables receive runtime
 * exceptions; libraries and crash reporters are signed with an empty plist.
 */
export function entitlementProfileForMacTarget(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');

  if (isBundleOrExecutable(normalized, 'NexusIDE Helper (Plugin).app')) {
    return PLUGIN_ENTITLEMENTS_PATH;
  }
  // getUserMedia and the WebAudio capture pipeline run in Electron's Renderer
  // Helper, not in the top-level executable. Keep the microphone grant scoped
  // to that helper only; GPU/plugin/framework targets remain narrower.
  if (isBundleOrExecutable(normalized, 'NexusIDE Helper (Renderer).app')) {
    return RENDERER_ENTITLEMENTS_PATH;
  }
  if (
    isBundleOrExecutable(normalized, 'NexusIDE Helper.app') ||
    isBundleOrExecutable(normalized, 'NexusIDE Helper (GPU).app')
  ) {
    return HELPER_ENTITLEMENTS_PATH;
  }
  if (isBundleOrExecutable(normalized, 'NexusIDE.app')) {
    return APP_ENTITLEMENTS_PATH;
  }
  return EMPTY_ENTITLEMENTS_PATH;
}

export function isAppleReleaseSigning(teamId: string | undefined): boolean {
  return APPLE_TEAM_ID_PATTERN.test(teamId?.trim() ?? '');
}

export function assertMacPublishReleaseEnvironment(
  environment: NodeJS.ProcessEnv,
): { teamId: string; keychainProfile: string } {
  if (environment.NEXUS_MAC_PUBLISH_RELEASE !== '1') {
    throw new Error(
      'NEXUS_MAC_PUBLISH_RELEASE must be exactly "1" for a publishable release.',
    );
  }
  if (environment.APPLE_TEAM_ID !== EXPECTED_APPLE_TEAM_ID) {
    throw new Error(
      `APPLE_TEAM_ID must be exactly ${EXPECTED_APPLE_TEAM_ID}.`,
    );
  }
  if (environment.APPLE_KEYCHAIN_PROFILE !== EXPECTED_NOTARY_PROFILE) {
    throw new Error(
      `APPLE_KEYCHAIN_PROFILE must be exactly "${EXPECTED_NOTARY_PROFILE}".`,
    );
  }
  for (const forbidden of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']) {
    if (environment[forbidden]) {
      throw new Error(
        `${forbidden} must not be exported; use the "${EXPECTED_NOTARY_PROFILE}" keychain profile.`,
      );
    }
  }
  return {
    teamId: EXPECTED_APPLE_TEAM_ID,
    keychainProfile: EXPECTED_NOTARY_PROFILE,
  };
}

/**
 * Resources such as the asar, locale packs, sprites and wake models are
 * opaque data, not Mach-O code. osx-sign walks every binary-looking resource
 * and otherwise invokes codesign on them; with a Developer ID identity that
 * makes the release stall/retry on harmless .webp/.pak files. Native modules
 * and the PTY helper remain signable and are deliberately kept in the walk.
 */
export function shouldIgnoreMacSigningFile(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  // Electron also stores locale packs and other data beside its framework
  // binaries, so the resource-root check alone is not sufficient.
  if (
    /\.(?:asar|bin|bmp|css|gif|html?|icns|jpe?g|js|json|map|md|mjs|onnx|pak|png|svg|txt|wasm|webp|woff2?|xml|zip)$/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  if (!normalized.includes('/Contents/Resources/')) return false;
  return !(/\.(?:node|dylib)$/u.test(normalized) || /\/spawn-helper$/u.test(normalized));
}

export function createMacSignOptions(teamId: string | undefined) {
  if (teamId !== undefined && !isAppleReleaseSigning(teamId)) {
    throw new Error('Apple Team ID must contain exactly 10 uppercase letters or digits.');
  }
  const isRelease = isAppleReleaseSigning(teamId);
  const normalizedTeamId = teamId?.trim();
  return {
    // A partially signed bundle is never a releasable artifact. Make the
    // osx-sign contract explicit instead of relying on its default.
    continueOnError: false,
    identity: isRelease
      ? `${EXPECTED_DEVELOPER_ID_IDENTITY} (${normalizedTeamId})`
      : '-',
    ...(isRelease ? {} : { identityValidation: false }),
    ignore: shouldIgnoreMacSigningFile,
    optionsForFile: (filePath: string) => ({
      entitlements: entitlementProfileForMacTarget(filePath),
      hardenedRuntime: isRelease,
      // Leaving this undefined in release mode makes @electron/osx-sign use
      // codesign's Apple-provided TSA (`--timestamp`). A URL override is both
      // unnecessary and less resilient across Apple timestamp backends.
      ...(isRelease ? {} : { timestamp: 'none' }),
    }),
  };
}
