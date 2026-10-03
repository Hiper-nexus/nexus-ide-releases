import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupSessionArtifacts,
  prepareEphemeralHome,
  writeClaudeFamilyZeroClickSettings,
} from './hooks-gen';
import { WEB_FETCH_DENY_MESSAGE } from './nexus-browser-policy';

const TOKEN = `web-fetch-deny-test-${process.pid}-${Date.now()}`;

type HookEntry = { matcher?: string; hooks?: Array<{ command?: string }> };
type ClaudeSettings = { hooks?: Record<string, HookEntry[]> };

let home = '';

beforeEach(() => {
  // Os dois canais escrevem em ~/.nexus: o teste nunca toca o HOME real.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-web-fetch-home-'));
  vi.stubEnv('HOME', home);
});

afterEach(() => {
  cleanupSessionArtifacts(TOKEN);
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Os dois canais de settings Claude-family que o spawn monta (mcp-server.ts). */
function settingsFor(
  channel: 'ephemeral-home' | 'flag-settings',
  denyWebFetch?: boolean,
): ClaudeSettings {
  const options = denyWebFetch === undefined ? {} : { denyWebFetch };
  const file =
    channel === 'ephemeral-home'
      ? path.join(prepareEphemeralHome(TOKEN, {}, options).dir, '.claude', 'settings.json')
      : writeClaudeFamilyZeroClickSettings(TOKEN, options);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeSettings;
}

function webFetchEntries(settings: ClaudeSettings): HookEntry[] {
  return (settings.hooks?.PreToolUse ?? []).filter(
    (entry) => entry.matcher === 'WebFetch',
  );
}

describe('F-781: settings gerado nega o WebFetch com a dica do navegador do Nexus', () => {
  it.each(['ephemeral-home', 'flag-settings'] as const)(
    '%s: PreToolUse/WebFetch carrega a dica, sem tirar os hooks que já existiam',
    (channel) => {
      const settings = settingsFor(channel, true);
      const entries = webFetchEntries(settings);
      expect(entries).toHaveLength(1);
      const command = entries[0]?.hooks?.[0]?.command ?? '';
      expect(command).toContain(WEB_FETCH_DENY_MESSAGE);
      expect(command).toContain('exit 2');
      expect(command).toContain('NEXUS_HOOK_STATUS');

      // O hook de status (tool-use) e o portão de integração continuam.
      const preToolUse = JSON.stringify(settings.hooks?.PreToolUse ?? []);
      expect(preToolUse).toContain('X-Nexus-Hook-Event: tool-use');
      expect(preToolUse).toContain('NEXUS_HOOK_INTEGRATION_URL');
      if (channel === 'ephemeral-home') {
        // …e o portão de skill (fail-closed) do worker governado também.
        expect(preToolUse).toContain('nexus-gate.mjs');
      }
    },
  );

  it.each(['ephemeral-home', 'flag-settings'] as const)(
    '%s: sem o navegador ao alcance, nada muda (fallback seguro)',
    (channel) => {
      expect(webFetchEntries(settingsFor(channel))).toEqual([]);
      expect(webFetchEntries(settingsFor(channel, false))).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'o comando do hook bloqueia (exit 2) e entrega a dica no stderr',
    () => {
      const command =
        webFetchEntries(settingsFor('flag-settings', true))[0]?.hooks?.[0]?.command ?? '';
      // Mesmo contrato do Claude Code: corpo do PreToolUse no stdin, exit 2 =
      // bloqueio e o stderr vai para o agente.
      const run = spawnSync('/bin/sh', ['-c', command], {
        input: JSON.stringify({
          tool_name: 'WebFetch',
          tool_input: { url: 'https://docs.example.com', prompt: 'resuma' },
        }),
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(run.status).toBe(2);
      expect(run.stderr).toBe(`${WEB_FETCH_DENY_MESSAGE}\n`);
      expect(run.stdout).toBe('');
    },
  );
});
