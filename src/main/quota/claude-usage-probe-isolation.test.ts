import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_CLI_PROBE_ENV,
  CLAUDE_CLI_USAGE_ARGS,
  claudeCliProbeEnv,
  probeClaudeCliUsage,
} from './claude-oauth-usage';

const posixIt = process.platform === 'win32' ? it.skip : it;

/**
 * F-966 (PRV-08): o `/usage` roda a cada poucos minutos. Sem isolamento, cada
 * sonda dispara os hooks do operador (SessionStart etc.), conecta os MCP do
 * claude.ai e procura IDE.
 */
describe('F-966: sonda /usage do Claude isolada de hooks, MCP e IDE', () => {
  let root: string;
  const saved = { HOME: process.env.HOME, FORCE_CODE_TERMINAL: process.env.FORCE_CODE_TERMINAL };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-claude-probe-'));
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('o argv desliga todos os hooks e todo MCP de arquivo', () => {
    const settings = CLAUDE_CLI_USAGE_ARGS.indexOf('--settings');
    expect(settings).toBeGreaterThan(-1);
    expect(JSON.parse(CLAUDE_CLI_USAGE_ARGS[settings + 1]!)).toEqual({ disableAllHooks: true });
    expect(CLAUDE_CLI_USAGE_ARGS).toContain('--strict-mcp-config');
    expect(CLAUDE_CLI_USAGE_ARGS).not.toContain('--mcp-config');
    expect(CLAUDE_CLI_USAGE_ARGS.at(-1)).toBe('/usage');
  });

  it('a env de isolamento vence a da conta e tira o terminal de IDE forçado', () => {
    const env = claudeCliProbeEnv(
      { PATH: '/bin', FORCE_CODE_TERMINAL: 'vscode', ENABLE_CLAUDEAI_MCP_SERVERS: 'true' },
      { CLAUDE_CONFIG_DIR: '/conta/quota', CLAUDE_CODE_AUTO_CONNECT_IDE: '1' },
      '/sonda',
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/conta/quota',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
      PWD: '/sonda',
    });
    expect(env).not.toHaveProperty('FORCE_CODE_TERMINAL');
  });

  posixIt('o processo real da sonda recebe argv e env isolados', async () => {
    // Binário falso no primeiro candidato (~/.local/bin/claude): grava o que
    // recebeu e responde como o `/usage` real.
    process.env.HOME = root;
    process.env.FORCE_CODE_TERMINAL = 'vscode';
    const bin = path.join(root, '.local', 'bin', 'claude');
    const record = path.join(root, 'probe-record');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `{ for a in "$@"; do printf 'ARG:%s\\n' "$a"; done; env | sed 's/^/ENV:/'; } > '${record}'`,
        "printf 'Current session: 12%% used\\n'",
      ].join('\n'),
      { mode: 0o755 },
    );

    const probe = await probeClaudeCliUsage({ cwd: path.join(root, 'cwd') });

    expect(probe.windows?.[0]?.usedRatio).toBeCloseTo(0.12);
    const lines = fs.readFileSync(record, 'utf8').split('\n');
    const args = lines.filter((line) => line.startsWith('ARG:')).map((line) => line.slice(4));
    expect(args).toEqual([...CLAUDE_CLI_USAGE_ARGS]);
    const env = new Map(
      lines
        .filter((line) => line.startsWith('ENV:'))
        .map((line) => line.slice(4).split(/=(.*)/su).slice(0, 2) as [string, string]),
    );
    for (const [name, value] of Object.entries(CLAUDE_CLI_PROBE_ENV)) {
      expect(env.get(name)).toBe(value);
    }
    expect(env.has('FORCE_CODE_TERMINAL')).toBe(false);
  });
});
