import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  OPENCLAUDE_CREDENTIALS_MAX_BYTES,
  openclaudeConfigDir,
  openclaudeSignedIn,
  probeOpenClaudeCliUsage,
  probeOpenClaudeUsage,
  resolveOpenClaudeToken,
} from './openclaude-usage';
import { parseClaudeCliUsage } from './claude-oauth-usage';

describe('openclaude-usage', () => {
  it('reads the native token from ~/.openclaude/.credentials.json', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-openclaude-'));
    fs.mkdirSync(path.join(home, '.openclaude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.openclaude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-oc' } }),
    );
    expect(await resolveOpenClaudeToken(home)).toBe('sk-ant-oat01-oc');
    expect(openclaudeSignedIn(home)).toBe(true);
    expect(openclaudeConfigDir(home)).toBe(path.join(home, '.openclaude'));
  });

  it('returns null when there is no usable credential', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-openclaude-'));
    expect(await resolveOpenClaudeToken(home)).toBeNull();
    expect(openclaudeSignedIn(home)).toBe(false);
  });

  it('prefers OAuth usage and reports auth-expired on 401', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '',
    }));
    const cliProbe = vi.fn(async () => ({
      windows: null,
      failure: 'auth-expired' as const,
    }));
    const probe = await probeOpenClaudeUsage({
      token: 'sk-ant-oat01-dead',
      fetchImpl: fetchImpl as never,
      now: 100,
      cliProbe,
    });
    expect(probe).toEqual({ windows: null, failure: 'auth-expired' });
    expect(cliProbe).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.anything(),
    );
  });

  it('falls back to CLI /usage when OAuth has no windows', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    }));
    const cliProbe = vi.fn(async () => ({
      windows: parseClaudeCliUsage(
        'Current session: 12% used · resets Sep 7 at 2:59pm (UTC)\n',
        100,
      ),
    }));
    const probe = await probeOpenClaudeUsage({
      token: 'sk-ant-oat01-ok',
      fetchImpl: fetchImpl as never,
      now: 100,
      cliProbe,
    });
    expect(probe.windows?.map((w) => [w.kind, w.usedRatio])).toEqual([
      ['session', 0.12],
    ]);
  });

  it('CLI probe never invents windows when the binary is gone', async () => {
    const probe = await probeOpenClaudeCliUsage({
      runImpl: async () => ({ code: -1, stdout: '', stderr: '' }),
      home: fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-openclaude-')),
    });
    if (probe.windows) {
      expect(probe.windows.length).toBeGreaterThanOrEqual(0);
    } else {
      expect(['cli-missing', 'unavailable', 'auth-expired']).toContain(
        probe.failure,
      );
    }
  });
});

describe('credencial do OpenClaude sem readFileSync sem teto (F-1417)', () => {
  it.skipIf(process.platform === 'win32')('FIFO ou arquivo gigante não é lido nem pendura', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-oc-'));
    const prev = process.env.OPENCLAUDE_CONFIG_DIR;
    delete process.env.OPENCLAUDE_CONFIG_DIR;
    try {
      const dir = path.join(home, '.openclaude');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '.credentials.json');
      execFileSync('mkfifo', [file]);
      expect(openclaudeSignedIn(home)).toBe(false);
      fs.rmSync(file);
      fs.writeFileSync(file, JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-ant-oat01-big' }, pad: 'x'.repeat(OPENCLAUDE_CREDENTIALS_MAX_BYTES),
      }));
      expect(openclaudeSignedIn(home)).toBe(false);
      fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-ok' } }));
      expect(openclaudeSignedIn(home)).toBe(true);
      expect(await resolveOpenClaudeToken(home)).toBe('sk-ant-oat01-ok');
    } finally {
      if (prev === undefined) delete process.env.OPENCLAUDE_CONFIG_DIR; else process.env.OPENCLAUDE_CONFIG_DIR = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
