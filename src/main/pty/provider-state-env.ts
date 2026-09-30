import path from 'node:path';
import fs from 'node:fs';
import { ensurePrivateDirectory } from '../orch/cli-mcp-session-artifacts';

/**
 * F-567: durable conversations below provider-state/<adapter>/<checkoutId>.
 * Same path/identity convention as cli-mcp-session-artifacts.ts (F-566).
 *
 * amp: XDG_DATA_HOME relocates the local thread mirror; server threads remain remote.
 * goose: XDG_DATA_HOME for older builds, GOOSE_PATH_ROOT for current builds on
 * all platforms (data/config/state). Only config.yaml is shared, never the DB.
 * pi: PI_CODING_AGENT_SESSION_DIR; prime-agent: PRIME_AGENT_SESSION_DIR.
 * copilot: COPILOT_HOME (documented); hermes: HERMES_HOME (also verified in the
 * installed hermes_constants.py). Their auth/config files need an overlay too.
 * cursor: --help exposes no state-root flag; private HOME, selected CLI config.
 * droid: no documented state-root flag; private HOME/.factory. Binary unavailable
 * locally; auth uses Keychain or auth.json/auth-fallback.json, settings stay shared.
 * command-code: private HOME/.commandcode; only documented auth/config files.
 *
 * Pure plan, NOT filesystem isolation: the spawn owner must materialize selected
 * regular files only, reject symlink ancestors/targets as F-566 does, and grant
 * exact sandbox paths. Never link a provider directory, import old conversations,
 * purge stateRoot on exit, or sync its conversation files to the real profile.
 * Apply after untrusted env/argv; conflicting CLI state-root flags must be rejected.
 * Sources and remaining runtime validation are recorded in docs/qa/items/F-567.md.
 */
export type ProviderStatePlan = {
  stateRoot: string;
  env: Record<string, string>;
  homeOverlay?: {
    /** Link only these relative files from sourceDir into targetDir. */
    sourceDir: string;
    targetDir: string;
    link: string[];
  };
};

export function providerStateEnvFor(
  adapterId: string,
  options: {
    userDataDir: string;
    checkoutId: string;
    home: string;
    platform?: NodeJS.Platform;
  },
): ProviderStatePlan | null {
  if (!['droid', 'cursor', 'copilot', 'amp', 'goose', 'pi', 'prime-agent', 'hermes', 'command-code'].includes(adapterId)) return null;
  const { userDataDir, checkoutId, home, platform = process.platform } = options;
  // ponytail: reuse F-566's convention, not its effectful mkdir/link helper.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(checkoutId)) {
    throw new Error('Invalid provider-state checkout identity');
  }
  const p = platform === 'win32' ? path.win32 : path.posix;
  for (const dir of [userDataDir, home]) {
    if (!p.isAbsolute(dir) || /[\x00-\x1f\x7f]/.test(dir) ||
        (platform === 'win32' && !p.parse(dir).root.startsWith('\\\\') && !/^[a-z]:[\\/]/i.test(dir))) {
      throw new Error('Provider-state roots must be absolute paths');
    }
  }
  const stateRoot = p.join(userDataDir, 'provider-state', adapterId, checkoutId);
  const plan: ProviderStatePlan = { stateRoot, env: {} };
  switch (adapterId) {
    case 'amp':
      plan.env.XDG_DATA_HOME = p.join(stateRoot, 'data');
      break;
    case 'pi':
      plan.env.PI_CODING_AGENT_SESSION_DIR = p.join(stateRoot, 'sessions');
      break;
    case 'prime-agent':
      plan.env.PRIME_AGENT_SESSION_DIR = p.join(stateRoot, 'sessions');
      break;
    case 'goose': {
      plan.env.XDG_DATA_HOME = p.join(stateRoot, 'data');
      plan.env.GOOSE_PATH_ROOT = stateRoot;
      const sourceDir = platform === 'win32'
        ? p.join(home, 'AppData', 'Roaming', 'Block', 'goose', 'config')
        : platform === 'darwin'
          ? p.join(home, 'Library', 'Application Support', 'Block', 'goose', 'config')
          : p.join(home, '.config', 'goose');
      plan.homeOverlay = { sourceDir, targetDir: p.join(stateRoot, 'config'), link: ['config.yaml'] };
      break;
    }
    case 'copilot':
    case 'hermes': {
      const profile = adapterId === 'copilot' ? '.copilot' : '.hermes';
      const targetDir = p.join(stateRoot, profile);
      plan.env[adapterId === 'copilot' ? 'COPILOT_HOME' : 'HERMES_HOME'] = targetDir;
      plan.homeOverlay = {
        sourceDir: adapterId === 'hermes' && platform === 'win32'
          ? p.join(home, 'AppData', 'Local', 'hermes') : p.join(home, profile),
        targetDir,
        link: adapterId === 'copilot' ? ['config.json', 'mcp-config.json'] : ['auth.json', '.env', 'config.yaml'],
      };
      break;
    }
    default: {
      const privateHome = p.join(stateRoot, 'home');
      plan.env.HOME = privateHome;
      plan.env.USERPROFILE = privateHome;
      // Prevent inherited XDG/AppData roots from bypassing the private HOME.
      plan.env.XDG_CONFIG_HOME = p.join(privateHome, '.config');
      plan.env.XDG_DATA_HOME = p.join(privateHome, '.local', 'share');
      plan.env.XDG_STATE_HOME = p.join(privateHome, '.local', 'state');
      plan.env.XDG_CACHE_HOME = p.join(privateHome, '.cache');
      if (platform === 'win32') {
        plan.env.APPDATA = p.join(privateHome, 'AppData', 'Roaming');
        plan.env.LOCALAPPDATA = p.join(privateHome, 'AppData', 'Local');
      }
      const profile = adapterId === 'droid' ? '.factory' : adapterId === 'cursor' ? '.cursor' : '.commandcode';
      const files = adapterId === 'droid'
        ? ['auth.json', 'auth-fallback.json', 'settings.json', 'config.json', 'mcp.json']
        : adapterId === 'cursor'
          ? ['cli-config.json', 'mcp.json']
          : ['auth.json', 'config.json', 'settings.json', 'providers.json', 'mcp.json'];
      plan.homeOverlay = { sourceDir: home, targetDir: privateHome, link: files.map(file => p.join(profile, file)) };
    }
  }
  return plan;
}

/** Materialize a Main-owned plan; returns exact native auth/config grants.
 * Conversation roots are real private directories, never links to native stores.
 * Windows junctions only support directories: this file-only allowlist uses
 * hardlinks instead, failing closed across volumes rather than copying secrets.
 */
export function materializeProviderState(
  plan: ProviderStatePlan,
  userDataDir: string,
): string[] {
  const boundary = path.resolve(userDataDir);
  const stateRoot = path.resolve(plan.stateRoot);
  function ensureDirectory(dir: string): void {
    const relative = path.relative(boundary, dir);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Provider state must remain inside userData');
    }
    let current = boundary;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error('Provider state directory must not be a symlink');
      }
      ensurePrivateDirectory(current);
    }
  }
  ensureDirectory(stateRoot);
  for (const dir of new Set(Object.values(plan.env))) ensureDirectory(dir);
  const sharedFiles: string[] = [];
  const overlay = plan.homeOverlay;
  if (!overlay) return sharedFiles;
  ensureDirectory(overlay.targetDir);
  for (const relative of overlay.link) {
    const source = path.resolve(overlay.sourceDir, relative);
    const target = path.resolve(overlay.targetDir, relative);
    if (!target.startsWith(`${stateRoot}${path.sep}`)) {
      throw new Error('Provider config target must remain inside checkout state');
    }
    ensureDirectory(path.dirname(target));
    let targetEntry = fs.lstatSync(target, { throwIfNoEntry: false });
    if (targetEntry?.isSymbolicLink()) {
      const linked = path.resolve(path.dirname(target), fs.readlinkSync(target));
      if (path.toNamespacedPath(linked) !== path.toNamespacedPath(source)) {
        // A CLI may consolidate config aliases into links inside this state
        // root, and an older materialization may point at a different file
        // under the same profile source. Both are ours to re-point — the
        // link is never followed. Any other target is tampering.
        const roots = [overlay.targetDir, overlay.sourceDir]
          .map((root) => path.toNamespacedPath(path.resolve(root) + path.sep));
        if (!roots.some((root) => path.toNamespacedPath(linked).startsWith(root))) {
          throw new Error('Provider config link points outside its auth source');
        }
        fs.unlinkSync(target);
        targetEntry = undefined;
      }
    } else if (targetEntry && !targetEntry.isFile()) {
      throw new Error('Provider config target must be a regular file');
    }
    let sourceEntry: fs.Stats;
    try {
      sourceEntry = fs.statSync(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!sourceEntry.isFile()) throw new Error('Provider auth/config source must be a regular file');
    if (!targetEntry) {
      if (process.platform === 'win32') fs.linkSync(source, target);
      else fs.symlinkSync(source, target, 'file');
    }
    // CLI atomic renames may replace a link with a private regular file. Keep
    // that fresh login/config; never overwrite it or sync conversations back.
    const actualTarget = fs.statSync(target);
    if (actualTarget.dev === sourceEntry.dev && actualTarget.ino === sourceEntry.ino) {
      sharedFiles.push(fs.realpathSync(source));
    }
  }
  return sharedFiles;
}
