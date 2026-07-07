import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import {
  OPS_CHANNELS,
  type AuditLogSnapshot,
  type ReleaseReadinessCheck,
  type ReleaseReadinessSnapshot,
} from '../../shared/ops-ipc';
import { CURRENT_RELEASE } from '../../shared/release-notes';
import { getAuditLogPath, readAuditLog } from '../jarvis/audit-log';

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
  if (process.env.NEXUS_UPDATE_FEED?.trim()) return 'feed';
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
    label: 'Versão 0.10.6 alinhada',
    status: aligned ? 'pass' : 'fail',
    detail: `app=${appVersion}; package=${packageVersion ?? 'indisponível'}; release-notes=${CURRENT_RELEASE.version}`,
  };
}

function checkVisionEntitlementCopy(forgeConfig: string | null): ReleaseReadinessCheck {
  const hasCopy =
    forgeConfig?.includes('NSScreenCaptureUsageDescription') === true;
  return {
    id: 'screen-capture-copy',
    label: 'Permissão macOS de Screen Recording',
    status: hasCopy ? 'pass' : 'warn',
    detail: hasCopy
      ? 'Info.plist declara por que Jarvis Vision usa captura de tela.'
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

function checkPackageMakers(forgeConfig: string | null): ReleaseReadinessCheck {
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

export function buildReleaseReadinessSnapshot(): ReleaseReadinessSnapshot {
  const appVersion = app.getVersion();
  const packageVersion = readPackageVersion();
  const forgeConfig = readProjectFile(FORGE_CONFIG);
  const source = updateSource();
  return {
    checkedAt: new Date().toISOString(),
    appVersion,
    packageVersion,
    releaseNotesVersion: CURRENT_RELEASE.version,
    packaged: app.isPackaged,
    updateSource: source,
    checks: [
      checkVersionAlignment(appVersion, packageVersion),
      checkVisionEntitlementCopy(forgeConfig),
      checkUpdateSource(source),
      checkPackageMakers(forgeConfig),
    ],
  };
}

export function buildAuditLogSnapshot(limit = 80): AuditLogSnapshot {
  const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  return {
    path: getAuditLogPath(),
    readAt: new Date().toISOString(),
    entries: readAuditLog(boundedLimit),
  };
}

export function registerOpsIpc(): void {
  ipcMain.handle(OPS_CHANNELS.auditLog, (_event, rawLimit?: unknown) =>
    buildAuditLogSnapshot(typeof rawLimit === 'number' ? rawLimit : 80),
  );
  ipcMain.handle(OPS_CHANNELS.releaseReadiness, () =>
    buildReleaseReadinessSnapshot(),
  );
}
