import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const credential = z.object({
  type: z.literal('api'), key: z.string().trim().min(1),
  metadata: z.object({ uid: z.string().min(1).optional(), base_url: z.string().optional() }).optional(),
});
const authFile = z.object({ xiaomi: credential });
const API_HOSTS = new Set([
  'api.xiaomimimo.com', 'api.mimo.xiaomi.com',
  'token-plan-cn.xiaomimimo.com', 'token-plan-sgp.xiaomimimo.com',
  'token-plan-ams.xiaomimimo.com',
]);

export function mimoNativePaths(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const root = env.MIMOCODE_HOME?.trim();
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (root && !isAbsolute(root)) throw new Error('MIMOCODE_HOME deve ser um caminho absoluto');
  const xdg = (key: string, fallback: string) => {
    const value = env[key]?.trim();
    return value && isAbsolute(value) ? value : fallback;
  };
  // MiMo Code 0.1.14 no Windows grava o XDG Unix em %USERPROFILE%\.local\share,
  // não em %LOCALAPPDATA%. Um home de conta gerenciada segue o mesmo layout
  // relativo, para o teste não herdar o AppData do operador.
  const data = root
    ? join(root, 'data')
    : join(xdg('XDG_DATA_HOME', join(home, '.local', 'share')), 'mimocode');
  return {
    data,
    authFile: join(data, 'auth.json'),
    config: root
      ? join(root, 'config')
      : join(xdg('XDG_CONFIG_HOME', join(home, '.config')), 'mimocode'),
    state: root
      ? join(root, 'state')
      : join(xdg('XDG_STATE_HOME', join(home, '.local', 'state')), 'mimocode'),
    cache: root
      ? join(root, 'cache')
      : join(xdg('XDG_CACHE_HOME', join(home, '.cache')), 'mimocode'),
  };
}

/** Auth files the CLI may have written. The Unix path is the one 0.1.14 uses. */
export function mimoAuthCandidateFiles(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const primary = mimoNativePaths(home, env, platform).authFile;
  if (platform !== 'win32' || env.MIMOCODE_HOME?.trim()) return [primary];
  const local = env.LOCALAPPDATA?.trim();
  const join = path.win32.join;
  const isAbsolute = path.win32.isAbsolute;
  if (!local || !isAbsolute(local)) return [primary];
  const alternate = join(local, 'mimocode', 'auth.json');
  return alternate === primary ? [primary] : [primary, alternate];
}

/** First saved Xiaomi credential, or null. Never logs the key. */
export function readMimoNativeAuthBlob(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const file of mimoAuthCandidateFiles(home, env, platform)) {
    try {
      if (fs.statSync(file).size > 1_048_576) continue;
      const blob = mimoAuthSnapshot(fs.readFileSync(file, 'utf8'));
      if (blob) return blob;
    } catch {
      // Missing or unreadable candidate. Try the next layout.
    }
  }
  return null;
}

function parse(blob: string): z.infer<typeof authFile> | null {
  try {
    const parsed = authFile.safeParse(JSON.parse(blob));
    if (!parsed.success) return null;
    const raw = parsed.data.xiaomi.metadata?.base_url;
    if (raw) {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || !API_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) return null;
    }
    return parsed.data;
  } catch { return null; }
}

export function parseMimoAuth(blob: string): { key: string; uid?: string; baseUrl: string } | null {
  const parsed = parse(blob)?.xiaomi;
  return parsed ? { key: parsed.key, uid: parsed.metadata?.uid, baseUrl: parsed.metadata?.base_url?.replace(/\/$/, '') ?? 'https://api.xiaomimimo.com/v1' } : null;
}

/** A saved Xiaomi account must never include the CLI's other provider credentials. */
export function mimoAuthSnapshot(blob: string): string | null {
  const parsed = parse(blob);
  return parsed ? JSON.stringify(parsed) : null;
}

/** Token Plan's published model list excludes the API-only UltraSpeed tier. */
export function mimoCredentialSupportsModel(blob: string, model?: string): boolean {
  const auth = parseMimoAuth(blob);
  if (!auth) return false;
  if (model?.includes('/') && !model.startsWith('xiaomi/')) return false;
  if (!new URL(auth.baseUrl).hostname.startsWith('token-plan-') || !model) return true;
  return new Set([
    'mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.5-pro', 'mimo-v2.5',
    'mimo-v2.5-asr', 'mimo-v2.5-tts-voiceclone', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts',
  ]).has(model.replace(/^xiaomi\//, ''));
}
