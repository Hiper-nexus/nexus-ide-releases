const APP_ENTITLEMENTS_PATH = 'build/entitlements.mac.plist';
const HELPER_ENTITLEMENTS_PATH = 'build/entitlements.mac.helper.plist';
const RENDERER_ENTITLEMENTS_PATH = 'build/entitlements.mac.renderer.plist';
const PLUGIN_ENTITLEMENTS_PATH = 'build/entitlements.mac.plugin.plist';
const EMPTY_ENTITLEMENTS_PATH = 'build/entitlements.mac.none.plist';

export const EXPECTED_DEVELOPER_ID_IDENTITY =
  'Developer ID Application: Cleofas Pereira rocha';

/**
 * @electron/osx-sign calls optionsForFile for bundle containers, executables,
 * frameworks and native modules. Only Electron/V8 executables receive runtime
 * exceptions; libraries and crash reporters are signed with an empty plist.
 */
export function entitlementProfileForMacTarget(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');

  if (normalized.includes(' Helper (Plugin).app')) {
    return PLUGIN_ENTITLEMENTS_PATH;
  }
  // getUserMedia and the WebAudio capture pipeline run in Electron's Renderer
  // Helper, not in the top-level executable. Keep the microphone grant scoped
  // to that helper only; GPU/plugin/framework targets remain narrower.
  if (normalized.includes(' Helper (Renderer).app')) {
    return RENDERER_ENTITLEMENTS_PATH;
  }
  if (
    normalized.includes(' Helper.app') ||
    normalized.includes(' Helper (GPU).app')
  ) {
    return HELPER_ENTITLEMENTS_PATH;
  }
  if (
    normalized.endsWith('/NexusIDE.app') ||
    normalized.endsWith('/Contents/MacOS/NexusIDE')
  ) {
    return APP_ENTITLEMENTS_PATH;
  }
  return EMPTY_ENTITLEMENTS_PATH;
}

export function isAppleReleaseSigning(teamId: string | undefined): boolean {
  return Boolean(teamId?.trim());
}

export function createMacSignOptions(teamId: string | undefined) {
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
