import path from 'node:path';

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
