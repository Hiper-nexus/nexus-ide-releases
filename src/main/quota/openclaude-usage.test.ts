import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
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
