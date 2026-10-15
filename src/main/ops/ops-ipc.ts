import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { app, ipcMain } from 'electron';
import {
  OPS_CHANNELS,
  type AuditLogSnapshot,
  type ReleaseReadinessCheck,
  type ReleaseReadinessSnapshot,
} from '../../shared/ops-ipc';
import { CURRENT_RELEASE } from '../../shared/release-notes';
import type { ProjectExecutionScope } from '../../shared/types';
import { getAuditStoragePath, readAuditLog } from '../jarvis/audit-log';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { validateUpdateFeedUrl } from '../update-feed-policy';

const PACKAGE_JSON = 'package.json';
const FORGE_CONFIG = 'forge.config.ts';

function readProjectFile(fileName: string): string | null {
  const filePath = path.join(app.getAppPath(), fileName);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readPackageVersion(): string | null {
  const raw = readProjectFile(PACKAGE_JSON);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function updateSource(): ReleaseReadinessSnapshot['updateSource'] {
  if (validateUpdateFeedUrl(process.env.NEXUS_UPDATE_FEED?.trim())) return 'feed';
  return 'gh';
}

function checkVersionAlignment(
  appVersion: string,
  packageVersion: string | null,
): ReleaseReadinessCheck {
  const aligned =
    packageVersion === appVersion && CURRENT_RELEASE.version === appVersion;
  return {
    id: 'version-alignment',
    label: `Versão ${appVersion} alinhada`,
    status: aligned ? 'pass' : 'fail',
    detail: `app=${appVersion}; package=${packageVersion ?? 'indisponível'}; release-notes=${CURRENT_RELEASE.version}`,
  };
}

function packagedContentsPath(): string | null {
  if (!app.isPackaged || process.platform !== 'darwin') return null;
  return path.dirname(path.dirname(app.getPath('exe')));
}

/** Bounded async run of a pinned macOS signing/notarization tool. The
 * release-readiness check used to execFileSync/spawnSync codesign/spctl/stapler
 * on the Main thread and freeze the event loop for seconds on every poll. */
function runTool(
  file: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) return reject(error);
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

async function packagedInfoValue(key: string): Promise<string | null> {
  const contents = packagedContentsPath();
  if (!contents) return null;
  try {
    const { stdout } = await runTool(
      '/usr/bin/plutil',
      ['-extract', key, 'raw', '-o', '-', path.join(contents, 'Info.plist')],
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

async function checkVisionEntitlementCopy(forgeConfig: string | null): Promise<ReleaseReadinessCheck> {
  const packagedCopy = await packagedInfoValue('NSScreenCaptureUsageDescription');
  const hasCopy = app.isPackaged
    ? Boolean(packagedCopy)
    : forgeConfig?.includes('NSScreenCaptureUsageDescription') === true;
  return {
    id: 'screen-capture-copy',
    label: 'Permissão macOS de Screen Recording',
    status: hasCopy ? 'pass' : 'warn',
    detail: hasCopy
      ? `Info.plist declara o uso de captura${packagedCopy ? `: ${packagedCopy}` : '.'}`
      : 'Não foi possível confirmar NSScreenCaptureUsageDescription no forge config.',
  };
}

function checkUpdateSource(source: ReleaseReadinessSnapshot['updateSource']): ReleaseReadinessCheck {
  if (source === 'feed') {
    return {
      id: 'update-source',
      label: 'Fonte de auto-update',
      status: 'pass',
      detail: 'NEXUS_UPDATE_FEED configurado para feed Squirrel direto.',
    };
  }
  return {
    id: 'update-source',
    label: 'Fonte de auto-update',
    status: 'warn',
    detail:
      'Sem feed público configurado; fluxo usa gh CLI para releases privados e deve ser validado no build empacotado.',
  };
}

async function verifyPackagedSignature(): Promise<boolean> {
  const contents = packagedContentsPath();
  if (!contents) return false;
  try {
    await runTool(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', path.dirname(contents)],
    );
    const signature = await runTool(
      '/usr/bin/codesign',
      ['-d', '--verbose=4', path.dirname(contents)],
    );
    if (!signature.stderr.includes('Authority=Developer ID Application:')) {
      return false;
    }
    await runTool(
      '/usr/sbin/spctl',
      ['--assess', '--type', 'execute', '--verbose=2', path.dirname(contents)],
    );
    await runTool(
      '/usr/bin/xcrun',
      ['stapler', 'validate', path.dirname(contents)],
    );
    return true;
  } catch {
    return false;
  }
}

async function checkPackageMakers(forgeConfig: string | null): Promise<ReleaseReadinessCheck> {
  if (app.isPackaged) {
    const signed = await verifyPackagedSignature();
    return {
      id: 'packaging-artifacts',
      label: 'Developer ID, Gatekeeper e notarização',
      status: signed ? 'pass' : 'fail',
      detail: signed
        ? 'Developer ID, Gatekeeper e ticket notarizado foram validados.'
        : 'O bundle não comprovou Developer ID + Gatekeeper + staple.',
    };
  }
  const hasDmg = forgeConfig?.includes('MakerDMG') === true;
  const hasZip = forgeConfig?.includes('MakerZIP') === true;
  const hasSigning = forgeConfig?.includes('osxSign') === true;
  const ok = hasDmg && hasZip && hasSigning;
  return {
    id: 'packaging-artifacts',
    label: 'DMG/ZIP e assinatura',
    status: ok ? 'pass' : 'warn',
    detail: `DMG=${hasDmg ? 'ok' : 'não confirmado'}; ZIP=${hasZip ? 'ok' : 'não confirmado'}; osxSign=${hasSigning ? 'ok' : 'não confirmado'}`,
  };
}

export async function buildReleaseReadinessSnapshot(): Promise<ReleaseReadinessSnapshot> {
  const appVersion = app.getVersion();
  const packageVersion = readPackageVersion() ?? (app.isPackaged ? appVersion : null);
  const forgeConfig = readProjectFile(FORGE_CONFIG);
  const source = updateSource();
  const [visionEntitlementCopy, packageMakers] = await Promise.all([
    checkVisionEntitlementCopy(forgeConfig),
    checkPackageMakers(forgeConfig),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    appVersion,
    packageVersion,
    releaseNotesVersion: CURRENT_RELEASE.version,
    packaged: app.isPackaged,
    updateSource: source,
    checks: [
      checkVersionAlignment(appVersion, packageVersion),
      visionEntitlementCopy,
      checkUpdateSource(source),
      packageMakers,
    ],
  };
}

export function buildAuditLogSnapshot(
  scope: ProjectExecutionScope,
  limit = 80,
): AuditLogSnapshot {
  const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const context = { scope };
  return {
    path: getAuditStoragePath(context),
    readAt: new Date().toISOString(),
    entries: readAuditLog(context, boundedLimit),
  };
}

export function registerOpsIpc(): void {
  ipcMain.handle(OPS_CHANNELS.auditLog, (event, rawLimit?: unknown) =>
    buildAuditLogSnapshot(
      requireRendererWorkspaceScope(event.sender),
      typeof rawLimit === 'number' ? rawLimit : 80,
    ),
  );
  ipcMain.handle(OPS_CHANNELS.releaseReadiness, async () =>
    buildReleaseReadinessSnapshot(),
  );
}
