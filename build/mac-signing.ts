const APP_ENTITLEMENTS_PATH = 'build/entitlements.mac.plist';
const HELPER_ENTITLEMENTS_PATH = 'build/entitlements.mac.helper.plist';
const RENDERER_ENTITLEMENTS_PATH = 'build/entitlements.mac.renderer.plist';
const PLUGIN_ENTITLEMENTS_PATH = 'build/entitlements.mac.plugin.plist';
const EMPTY_ENTITLEMENTS_PATH = 'build/entitlements.mac.none.plist';

export const EXPECTED_DEVELOPER_ID_IDENTITY =
  'Developer ID Application: Cleofas Pereira rocha';

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
    optionsForFile: (filePath: string) => ({
      entitlements: entitlementProfileForMacTarget(filePath),
      hardenedRuntime: isRelease,
      ...(isRelease ? {} : { timestamp: 'none' }),
    }),
  };
}
