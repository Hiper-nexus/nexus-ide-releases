import path from 'node:path';
import fs from 'node:fs';
import { activateArtifact, ensurePrivateDirectory, getActiveCliMcpArtifact, withCliMcpArtifactTransaction } from './cli-mcp-session-artifacts';
import { writeFileAtomicAsync } from '../util/atomic-write';

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/** Main-selected resource references only; no bearer/URL/env dump is persisted. */
export function museNativeHeavySettings(original: Record<string, unknown>, node: string, directory: string): Record<string, unknown> {
  if (!path.isAbsolute(node) || !path.isAbsolute(directory)) throw new Error('muse_heavy_resource_invalid');
  const hooks = original.hooks;
  if (hooks !== undefined && (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))) throw new Error('muse_heavy_hooks_invalid');
  const existing = (hooks as Record<string, unknown> | undefined)?.PreToolUse;
  if (existing !== undefined && !Array.isArray(existing)) throw new Error('muse_heavy_hooks_invalid');
  return { ...original, hooks: { ...(hooks as Record<string, unknown> | undefined), PreToolUse: [...(existing as unknown[] | undefined ?? []), {
    matcher: 'bash', hooks: [{ type: 'command', command: `NODE_OPTIONS= NEXUS_HOOK_STATUS=1 NEXUS_HEAVY_TOOL_PREEXEC=1 ${quote(node)} ${quote(path.join(directory, 'muse-tool-hook.cjs'))}` }],
  }] } };
}

export interface MuseNativeHeavyProfileOptions {
  token: string;
  home: string;
  xdgConfigHome?: string;
  artifactRoot: string;
  node: string;
  resourceDirectory: string;
}
/** Reserve the private config synchronously; all selected config reads happen after Main records the pane. */
export function reserveMuseNativeHeavyProfile(options: MuseNativeHeavyProfileOptions): {
  env: { XDG_CONFIG_HOME: string };
  initialize: (assertCurrent: () => void) => Promise<void>;
} {
  if (!options.token || ![options.home, options.artifactRoot, options.node, options.resourceDirectory].every(path.isAbsolute) ||
      options.xdgConfigHome && !path.isAbsolute(options.xdgConfigHome)) throw new Error('muse_heavy_resource_invalid');
  const selected = options.xdgConfigHome?.trim() || path.join(options.home, '.config');
  return withCliMcpArtifactTransaction('muse', options.token, options.artifactRoot, (artifactDir) => {
    const directory = path.join(artifactDir, 'muse'), file = path.join(directory, 'settings.json');
    ensurePrivateDirectory(directory);
    const rootIdentity = fs.lstatSync(artifactDir), directoryIdentity = fs.lstatSync(directory);
    const artifact = { artifactDir, providerHome: null, configFiles: ['muse'], syncBack: false };
    activateArtifact(options.token, artifact);
    let initialized: Promise<void> | undefined;
    return { env: { XDG_CONFIG_HOME: artifactDir }, initialize: (assertCurrent) => {
      const current = () => {
        assertCurrent();
        const rootNow = fs.lstatSync(artifactDir), now = fs.lstatSync(directory);
        if (getActiveCliMcpArtifact(options.token) !== artifact || rootNow.dev !== rootIdentity.dev || rootNow.ino !== rootIdentity.ino ||
            now.dev !== directoryIdentity.dev || now.ino !== directoryIdentity.ino || !rootNow.isDirectory() || !now.isDirectory() ||
            fs.realpathSync(artifactDir) !== artifactDir) throw new Error('muse_heavy_artifact_changed');
      };
      const guarded = async <T>(operation: () => Promise<T>): Promise<T> => { current(); const value = await operation(); current(); return value; };
      const initialize = async () => {
        current();
        const root = await guarded(() => fs.promises.realpath(artifactDir));
        if (root !== artifactDir) throw new Error('muse_heavy_artifact_changed');
        let original: Record<string, unknown> = {};
        let source: string | undefined;
        try { source = await guarded(() => fs.promises.realpath(path.join(selected, 'muse/settings.json'))); }
        catch (error) { current(); if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (source) {
          current();
          const handle = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          try {
            current();
            const stat = await guarded(() => handle.stat());
            if (!stat.isFile() || stat.size > 1_048_576) throw new Error('muse_heavy_config_invalid');
            const bytes = Buffer.alloc(stat.size + 1); let total = 0;
            while (total < bytes.length) { const result = await guarded(() => handle.read(bytes, total, bytes.length - total, total)); if (!result.bytesRead) break; total += result.bytesRead; }
            if (total !== stat.size) throw new Error('muse_heavy_config_invalid');
            const value: unknown = JSON.parse(bytes.subarray(0, total).toString('utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('muse_heavy_config_invalid');
            original = value as Record<string, unknown>;
          } finally { await handle.close(); }
          current();
        }
        const linkSelected = async (sourceDir: string, targetDir: string, excluded: string) => {
          let entries: fs.Dirent[];
          try { entries = await guarded(() => fs.promises.readdir(sourceDir, { withFileTypes: true })); }
          catch (error) { current(); if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
          if (entries.length > 256) throw new Error('muse_heavy_config_invalid');
          for (const entry of entries) {
            if (entry.name === excluded) continue;
            const from = await guarded(() => fs.promises.realpath(path.join(sourceDir, entry.name)));
            await guarded(() => fs.promises.symlink(from, path.join(targetDir, entry.name)));
          }
        };
        await linkSelected(selected, artifactDir, 'muse'); current();
        await linkSelected(path.join(selected, 'muse'), directory, 'settings.json'); current();
        const document = JSON.stringify(museNativeHeavySettings(original, options.node, options.resourceDirectory));
        if (Buffer.byteLength(document) > 1_048_576) throw new Error('muse_heavy_config_invalid');
        await writeFileAtomicAsync(file, `${document}\n`, 0o600, { createDirectory: false, beforeCommit: () => {
          current();
          const rootNow = fs.lstatSync(artifactDir), now = fs.lstatSync(directory);
          let destinationExists = false;
          try { fs.lstatSync(file); destinationExists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (rootNow.dev !== rootIdentity.dev || rootNow.ino !== rootIdentity.ino || now.dev !== directoryIdentity.dev || now.ino !== directoryIdentity.ino ||
              fs.realpathSync(directory) !== directory || destinationExists) throw new Error('muse_heavy_artifact_changed');
        } });
        current();
      };
      return initialized ??= initialize();
    } };
  });
}
