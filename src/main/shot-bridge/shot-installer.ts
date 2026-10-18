/**
 * shot-installer: garante no macOS que o Nexus Shot instalado não é uma versão
 * conhecida como quebrada.
 *
 * Por quê: o Shot 0.1.14 crasha ~4 s depois de abrir no macOS 27, mas o
 * updater do próprio Shot só faz o primeiro check aos 10 s
 * (src-tauri/src/updater.rs, AUTO_CHECK_STARTUP_DELAY). Ele morre antes de
 * conseguir se atualizar, e o Nexus não tinha nenhum código que tocasse o Shot.
 *
 * Só atualiza uma instalação EXISTENTE abaixo de SHOT_MIN_VERSION (nunca
 * instala o Shot do zero). Fonte: o mesmo feed oficial do updater do Shot
 * (latest.json do repo público Hiper-nexus/nexus-shot-releases). Nada é
 * trocado sem que o bundle baixado passe em codesign --strict, Team ID
 * 35P5XL3JN6, Identifier com.nexuside.shot e spctl (notarização).
 *
 * Sem electron: toda a borda (rede, processos, fs) é injetada, como em
 * shot-bridge-server.ts, para testar em vitest puro.
 */

import { compareAppVersions, hasReachedAppVersion, isValidAppVersion } from '../../shared/app-version';

/** Menor Shot aceito: o 0.1.15 corrige o crash do macOS 27. */
export const SHOT_MIN_VERSION = '0.1.15';
export const SHOT_APP_PATH = '/Applications/Nexus Shot.app';
export const SHOT_BUNDLE_ID = 'com.nexuside.shot';
export const SHOT_TEAM_ID = '35P5XL3JN6';
export const SHOT_FEED_URL =
  'https://github.com/Hiper-nexus/nexus-shot-releases/releases/latest/download/latest.json';
/** O asset fica em github.com (redirect para githubusercontent é seguido pela rede injetada). */
const SHOT_ASSET_URL_PREFIX = 'https://github.com/Hiper-nexus/nexus-shot-releases/releases/download/';

export interface ShotRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ShotInstallerDeps {
  platform: NodeJS.Platform;
  arch: string;
  appPath: string;
  appExists(path: string): boolean;
  /** CFBundleShortVersionString do bundle, ou null se ilegível. */
  readBundleVersion(appPath: string): Promise<string | null>;
  isShotRunning(): Promise<boolean>;
  /** Há nexus-shot-*.ips recente em ~/Library/Logs/DiagnosticReports? */
  hasRecentShotCrash(): boolean;
  fetchText(url: string): Promise<string>;
  downloadTo(url: string, destFile: string): Promise<void>;
  run(cmd: string, args: string[]): Promise<ShotRunResult>;
  /** Cria um diretório de staging irmão do app (mesmo volume, rename atômico). */
  makeStagingDir(parent: string): string;
  rename(from: string, to: string): void;
  remove(path: string): void;
  log(msg: string): void;
}

export type ShotEnsureResult =
  | { status: 'skipped'; reason: 'not-darwin' | 'not-installed' | 'up-to-date' | 'running' | 'unreadable-version' }
  | { status: 'updated'; from: string; to: string }
  | { status: 'failed'; reason: string };

export function darwinFeedPlatformKey(arch: string): string {
  return arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64';
}

interface FeedAsset {
  version: string;
  url: string;
}

export function parseShotFeed(raw: string, arch: string): FeedAsset | null {
  try {
    const feed = JSON.parse(raw) as { version?: unknown; platforms?: Record<string, { url?: unknown }> };
    const url = feed.platforms?.[darwinFeedPlatformKey(arch)]?.url;
    if (typeof feed.version !== 'string' || typeof url !== 'string') return null;
    if (!isValidAppVersion(feed.version) || !url.startsWith(SHOT_ASSET_URL_PREFIX)) return null;
    return { version: feed.version, url };
  } catch {
    return null;
  }
}

/** Confere assinatura, identidade e notarização do bundle extraído. Devolve o motivo da recusa, ou null. */
async function verifyShotBundle(deps: ShotInstallerDeps, bundle: string): Promise<string | null> {
  const strict = await deps.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  if (strict.code !== 0) return `codesign --verify falhou: ${strict.stderr.trim()}`;
  // codesign -dv escreve os campos em stderr.
  const info = await deps.run('/usr/bin/codesign', ['-dv', '--verbose=2', bundle]);
  const fields = `${info.stdout}\n${info.stderr}`;
  if (!new RegExp(`^TeamIdentifier=${SHOT_TEAM_ID}$`, 'm').test(fields)) return 'Team ID diferente de 35P5XL3JN6';
  if (!new RegExp(`^Identifier=${SHOT_BUNDLE_ID.replace(/\./g, '\\.')}$`, 'm').test(fields)) {
    return 'bundle id diferente de com.nexuside.shot';
  }
  const gatekeeper = await deps.run('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle]);
  if (gatekeeper.code !== 0) return `spctl recusou (notarização): ${gatekeeper.stderr.trim()}`;
  return null;
}

export async function ensureShotMinVersion(deps: ShotInstallerDeps): Promise<ShotEnsureResult> {
  if (deps.platform !== 'darwin') return { status: 'skipped', reason: 'not-darwin' };
  if (!deps.appExists(deps.appPath)) return { status: 'skipped', reason: 'not-installed' };
  const installed = await deps.readBundleVersion(deps.appPath);
  if (!installed || !isValidAppVersion(installed)) return { status: 'skipped', reason: 'unreadable-version' };
  // Abaixo do mínimo: atualiza. Já no mínimo mas com crash recente: atualiza só se o feed tiver algo mais novo.
  const belowMin = !hasReachedAppVersion(installed, SHOT_MIN_VERSION);
  if (!belowMin && !deps.hasRecentShotCrash()) return { status: 'skipped', reason: 'up-to-date' };
  const acceptable = (v: string): boolean =>
    belowMin ? hasReachedAppVersion(v, SHOT_MIN_VERSION) : isValidAppVersion(v) && compareAppVersions(v, installed) > 0;
  if (await deps.isShotRunning()) return { status: 'skipped', reason: 'running' };

  const fail = (reason: string): ShotEnsureResult => {
    deps.log(`[shot-installer] ${installed} não atualizado: ${reason}`);
    return { status: 'failed', reason };
  };

  let asset: FeedAsset | null;
  try {
    asset = parseShotFeed(await deps.fetchText(SHOT_FEED_URL), deps.arch);
  } catch (err) {
    return fail(`feed indisponível: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!asset) return fail('feed inválido ou sem asset para esta arquitetura');
  if (!acceptable(asset.version)) return fail(`feed ainda em ${asset.version}`);

  let staging: string | null = null;
  try {
    staging = deps.makeStagingDir(parentDir(deps.appPath));
    const archive = `${staging}/shot.tar.gz`;
    await deps.downloadTo(asset.url, archive);
    const untar = await deps.run('/usr/bin/tar', ['-xzf', archive, '-C', staging]);
    if (untar.code !== 0) return fail(`tar falhou: ${untar.stderr.trim()}`);
    const bundle = `${staging}/Nexus Shot.app`;
    const refusal = await verifyShotBundle(deps, bundle);
    if (refusal) return fail(refusal);
    const extracted = await deps.readBundleVersion(bundle);
    if (!extracted || !acceptable(extracted)) {
      return fail(`bundle baixado em ${extracted ?? 'versão ilegível'}`);
    }
    const backup = `${staging}/old.app`;
    deps.rename(deps.appPath, backup);
    try {
      deps.rename(bundle, deps.appPath);
    } catch (err) {
      deps.rename(backup, deps.appPath);
      throw err;
    }
    deps.log(`[shot-installer] Nexus Shot ${installed} -> ${extracted}`);
    return { status: 'updated', from: installed, to: extracted };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    if (staging) {
      try {
        deps.remove(staging);
      } catch {
        /* melhor esforço */
      }
    }
  }
}

function parentDir(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}
