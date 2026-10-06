import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STARTUP_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zlogout'] as const;
export interface HeavyZshProfile {
  readonly directory: string;
  readonly protectedWritePaths: readonly string[];
  readonly protectedDirectoryPaths: readonly string[];
}
const profiles = new Map<string, HeavyZshProfile>();

/** One private cache/profile per live token; only Main copies trusted startup code. */
export function prepareHeavyZshProfile(token: string, resources: string, home = os.homedir()): HeavyZshProfile {
  const existing = profiles.get(token);
  if (existing) return existing;
  if (!token || !/^[a-zA-Z0-9_-]+$/.test(token)) throw new Error('heavy_zsh_session_invalid');
  const parent = path.join(fs.realpathSync(home), '.nexus', 'ephemeral', token.slice(0, 12));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(parent) !== parent) throw new Error('heavy_zsh_profile_identity_invalid');
  const directory = fs.mkdtempSync(path.join(parent, 'heavy-zsh-'));
  try {
    for (const name of STARTUP_FILES) {
      const source = path.join(resources, name);
      if (fs.realpathSync(source) !== source || !fs.statSync(source).isFile()) throw new Error('heavy_command_resource_identity_invalid');
      fs.writeFileSync(path.join(directory, name), fs.readFileSync(source), { flag: 'wx', mode: 0o400 });
    }
    const protectedDirectoryPaths: string[] = [];
    for (let ancestor = directory; path.dirname(ancestor) !== ancestor; ancestor = path.dirname(ancestor)) protectedDirectoryPaths.push(ancestor);
    const profile = Object.freeze({ directory,
      protectedWritePaths: Object.freeze(STARTUP_FILES.flatMap(name => [path.join(directory, name), path.join(directory, name + '.zwc')])),
      protectedDirectoryPaths: Object.freeze(protectedDirectoryPaths) });
    profiles.set(token, profile);
    return profile;
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

export function heavyZshProfile(token: string | undefined): HeavyZshProfile | undefined {
  return token ? profiles.get(token) : undefined;
}

/** Called by the existing physical-session artifact teardown, never at logical handoff. */
export function cleanupHeavyZshProfile(token: string): void {
  const profile = profiles.get(token);
  profiles.delete(token);
  if (profile) fs.rmSync(profile.directory, { recursive: true, force: true });
}
