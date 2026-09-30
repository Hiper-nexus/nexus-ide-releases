// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: packages/core/src/agents/plugins/helpers/hooks.test.ts
// See src/vendor/emdash/hooks/LICENSE.md.
// Nexus adaptations: expectations updated to the Nexus transport (loopback
// gate URL env + bearer header + NEXUS_HOOK_STATUS marker); added coverage for
// filterUserHooks and the flavor header.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  NEXUS_HOOK_MARKER,
  NEXUS_HOOK_WINDOWS_MARKER,
  filterUserHooks,
  isNexusHookText,
  makeNotificationHookCommand,
  makeStdinHookCommand,
  makeWindowsPowerShellHookCommand,
} from './hook-commands';

describe('hook command helpers', () => {
  it('builds POSIX stdin hook commands', () => {
    expect(makeStdinHookCommand('stop', { platform: 'linux', flavor: 'claude' })).toBe(
      'NEXUS_HOOK_STATUS=1 curl -sf --connect-timeout 0.5 --max-time 1.5 ' +
        '--noproxy 127.0.0.1,localhost --output /dev/null -X POST ' +
        '-H "Content-Type: application/json" ' +
        '-H "authorization: Bearer $NEXUS_GATE_TOKEN" ' +
        '-H "X-Nexus-Hook-Event: stop" ' +
        '-H "X-Nexus-Hook-Flavor: claude" ' +
        '-d @- ' +
        '"$NEXUS_HOOK_URL" || true'
    );
  });

  it('builds POSIX fixed-body notification commands', () => {
    expect(
      makeNotificationHookCommand('permission_prompt', { platform: 'linux', flavor: 'codex' }),
    ).toBe(
      'NEXUS_HOOK_STATUS=1 curl -sf --connect-timeout 0.5 --max-time 1.5 ' +
        '--noproxy 127.0.0.1,localhost --output /dev/null -X POST ' +
        '-H "Content-Type: application/json" ' +
        '-H "authorization: Bearer $NEXUS_GATE_TOKEN" ' +
        '-H "X-Nexus-Hook-Event: notification" ' +
        '-H "X-Nexus-Hook-Flavor: codex" ' +
        `--data-binary '{"notification_type":"permission_prompt"}' ` +
        '"$NEXUS_HOOK_URL" || true'
    );
  });

  it('never embeds a token or URL literal — env references only', () => {
    const command = makeStdinHookCommand('start', { platform: 'linux', flavor: 'kimi' });
    expect(command).toContain('$NEXUS_GATE_TOKEN');
    expect(command).toContain('$NEXUS_HOOK_URL');
    expect(command).not.toMatch(/127\.0\.0\.1:\d/);
  });

  it('bounds loopback delivery and bypasses ambient proxy configuration', () => {
    const command = makeStdinHookCommand('start', {
      platform: 'linux',
      flavor: 'codex',
    });
    expect(command).toContain('--connect-timeout 0.5');
    expect(command).toContain('--max-time 1.5');
    expect(command).toContain('--noproxy 127.0.0.1,localhost');
  });

  it.runIf(process.platform !== 'win32')(
    'posts the hook payload without leaking the endpoint JSON to stdout',
    async () => {
      let receivedBody = '';
      const server = createServer((request, response) => {
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          receivedBody += chunk;
        });
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"ok":true,"applied":true}');
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        throw new Error('hook command test did not receive a TCP port');
      }
      try {
        const result = await new Promise<{
          code: number | null;
          stdout: string;
          stderr: string;
        }>((resolve, reject) => {
          const child = spawn(
            '/bin/sh',
            ['-c', makeStdinHookCommand('user-submit', {
              platform: process.platform,
              flavor: 'codex',
            })],
            {
              env: {
                PATH: '/usr/bin:/bin',
                NEXUS_GATE_TOKEN: 'test-token',
                NEXUS_HOOK_URL:
                  `http://127.0.0.1:${address.port}/hook/status`,
              },
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
          });
          child.once('error', reject);
          child.once('close', (code) => resolve({ code, stdout, stderr }));
          child.stdin.end('{"hook_event_name":"UserPromptSubmit"}');
        });
        expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(receivedBody).toBe(
          '{"hook_event_name":"UserPromptSubmit"}',
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('builds Windows hook commands as a bare PowerShell call (F-704)', () => {
    const command = makeNotificationHookCommand('idle_prompt', {
      platform: 'win32',
      flavor: 'codex',
    });

    expect(command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/]+=*$/
    );
    // O Git Bash do Claude Code converte todo argumento "/x" em caminho: o
    // `cmd.exe /d /c` virava interativo e engolia o stdin do hook.
    expect(command.split(' ').filter((arg) => arg.startsWith('/'))).toEqual([]);
    expect(command).not.toContain('cmd.exe');
  });

  it('keeps the Nexus marker recognizable in the encoded command, legacy form too', () => {
    const command = makeWindowsPowerShellHookCommand('Write-Output "ok"');
    expect(command).toContain(NEXUS_HOOK_WINDOWS_MARKER);
    expect(isNexusHookText(command)).toBe(true);
    const legacy = `cmd.exe /d /c echo ${NEXUS_HOOK_MARKER}>NUL&&powershell.exe -EncodedCommand AAAA`;
    const user = { hooks: [{ type: 'command', command: 'powershell.exe -EncodedCommand VwByAGkA' }] };
    expect(
      filterUserHooks([
        { hooks: [{ type: 'command', command }] },
        { hooks: [{ type: 'command', command: legacy }] },
        user,
      ]),
    ).toEqual([user]);
    const script = Buffer.from(command.split('-EncodedCommand ')[1]!, 'base64').toString('utf16le');
    expect(script).toContain('[Console]::InputEncoding = New-Object Text.UTF8Encoding $false');
    expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(script.endsWith('; Write-Output "ok"')).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'delivers the stdin payload intact when Git Bash runs the hook, as Claude Code does (F-704)',
    async () => {
      const payload = '{"hook_event_name":"UserPromptSubmit","prompt":"ação inválida ✓"}';
      let received = Buffer.alloc(0);
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          received = Buffer.concat(chunks);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no TCP port');
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(
            'bash',
            ['-c', makeStdinHookCommand('user-submit', { platform: 'win32', flavor: 'claude' })],
            {
              env: {
                ...process.env,
                NEXUS_GATE_TOKEN: 'test-token',
                NEXUS_HOOK_URL: `http://127.0.0.1:${address.port}/hook/status`,
              },
              stdio: ['pipe', 'ignore', 'ignore'],
            },
          );
          child.once('error', reject);
          child.once('close', resolve);
          child.stdin.end(Buffer.from(payload, 'utf8'));
        });
        expect(code).toBe(0);
        expect(received.toString('utf8')).toBe(payload);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    30_000,
  );

  it('filterUserHooks drops marker-bearing entries and keeps user hooks', () => {
    const ours = { hooks: [{ type: 'command', command: makeStdinHookCommand('stop') }] };
    const theirs = { hooks: [{ type: 'command', command: 'echo user-stop' }] };

    expect(filterUserHooks([ours, theirs])).toEqual([theirs]);
  });
});
