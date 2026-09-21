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

export function mimoNativePaths(home = os.homedir(), env: NodeJS.ProcessEnv = process.env) {
  const root = env.MIMOCODE_HOME?.trim();
  if (root && !path.isAbsolute(root)) throw new Error('MIMOCODE_HOME deve ser um caminho absoluto');
  const xdg = (key: string, fallback: string) => env[key] && path.isAbsolute(env[key]!) ? env[key]! : fallback;
  const data = root ? path.join(root, 'data') : path.join(xdg('XDG_DATA_HOME', path.join(home, '.local', 'share')), 'mimocode');
  return {
    data, authFile: path.join(data, 'auth.json'),
    config: root ? path.join(root, 'config') : path.join(xdg('XDG_CONFIG_HOME', path.join(home, '.config')), 'mimocode'),
    state: root ? path.join(root, 'state') : path.join(xdg('XDG_STATE_HOME', path.join(home, '.local', 'state')), 'mimocode'),
    cache: root ? path.join(root, 'cache') : path.join(xdg('XDG_CACHE_HOME', path.join(home, '.cache')), 'mimocode'),
  };
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
