import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../orch/cli-mcp-session-artifacts';

const HOOK_FILENAME = '__nexus_status.js';

/** File hooks remain active under MiMo --pure; payloads contain no conversation text. */
export function mimoStatusHookSource(): string {
  return `async function send(id, state) {
  const port = process.env.NEXUS_AGENT_HOOK_PORT;
  const token = process.env.NEXUS_AGENT_HOOK_TOKEN;
  const sessionToken = process.env.NEXUS_MIMO_HOOK_TOKEN;
  const paneKey = process.env.NEXUS_PANE_KEY;
  if (!/^[0-9]{1,5}$/.test(port || '') || Number(port) < 1 || Number(port) > 65535 ||
      !/^[a-f0-9]{32,128}$/i.test(token || '') || !/^[a-f0-9]{64}$/i.test(sessionToken || '') || !paneKey ||
      typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) return;
  try {
    await fetch('http://127.0.0.1:' + port + '/hook/mimo-code', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1500),
      headers: { 'Content-Type': 'application/json', 'X-Nexus-Agent-Hook-Token': token,
        'X-Nexus-Mimo-Session-Token': sessionToken },
      body: JSON.stringify({ paneKey, agentType: 'mimo-code', state,
        providerSession: { key: 'session_id', id } }),
    });
  } catch { /* Activity reporting must never interrupt the provider. */ }
}
export default {
  'chat.message': async (input) => send(input.sessionID, 'working'),
  event: async ({ event }) => {
    if (event.type !== 'session.status') return;
    const props = event.properties;
    const status = props?.status?.type;
    if (status === 'idle') await send(props.sessionID, 'done');
    else if (status === 'busy' || status === 'retry') await send(props.sessionID, 'working');
  },
};
`;
}

function linkEntry(source: string, target: string): void {
  if (process.platform === 'win32' && fs.statSync(source).isFile()) fs.linkSync(source, target);
  else fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : undefined);
}

/** Preserve an explicitly configured operator directory, never copy it into governed lanes. */
function projectCustomConfig(source: string, target: string): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.name !== 'hooks') { linkEntry(from, to); continue; }
    ensurePrivateDirectory(to);
    for (const name of fs.readdirSync(from)) {
      if (name === HOOK_FILENAME) throw new Error('MiMo custom hook uses a reserved Nexus filename');
      linkEntry(path.join(from, name), path.join(to, name));
    }
  }
}

export function installMimoStatusHook(artifactDir: string, governed: boolean, customConfigDir?: string): string {
  const config = path.join(artifactDir, 'nexus-hooks');
  ensurePrivateDirectory(config);
  if (!governed && customConfigDir?.trim()) {
    if (!path.isAbsolute(customConfigDir)) throw new Error('MiMo custom config directory must be absolute');
    if (fs.existsSync(customConfigDir)) projectCustomConfig(customConfigDir, config);
  }
  const hooks = path.join(config, 'hooks');
  ensurePrivateDirectory(hooks);
  writePrivateFileAtomic(path.join(hooks, HOOK_FILENAME), mimoStatusHookSource());
  return config;
}
