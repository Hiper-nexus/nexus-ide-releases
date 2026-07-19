// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: packages/core/src/agents/plugins/helpers/hooks.test.ts
// See src/vendor/emdash/hooks/LICENSE.md.
// Nexus adaptations: expectations updated to the Nexus transport (loopback
// gate URL env + bearer header + NEXUS_HOOK_STATUS marker); added coverage for
// filterUserHooks and the flavor header.

import { describe, expect, it } from 'vitest';
import {
  NEXUS_HOOK_MARKER,
  filterUserHooks,
  makeNotificationHookCommand,
  makeStdinHookCommand,
  makeWindowsPowerShellHookCommand,
} from './hook-commands';

describe('hook command helpers', () => {
  it('builds POSIX stdin hook commands', () => {
    expect(makeStdinHookCommand('stop', { platform: 'linux', flavor: 'claude' })).toBe(
      'NEXUS_HOOK_STATUS=1 curl -sf -X POST ' +
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
      'NEXUS_HOOK_STATUS=1 curl -sf -X POST ' +
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

  it('builds Windows hook commands without a quoted cmd.exe body', () => {
    const command = makeNotificationHookCommand('idle_prompt', {
      platform: 'win32',
      flavor: 'codex',
    });

    expect(command).toMatch(
      /^cmd\.exe \/d \/c echo NEXUS_HOOK_STATUS>NUL&&powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/]+=*$/
    );
    expect(command).toContain(NEXUS_HOOK_MARKER);
    expect(command).not.toContain('/c "');
    expect(command).not.toContain('& powershell.exe');
  });

  it('keeps the Nexus marker visible to hook config cleanup without PowerShell args', () => {
    const command = makeWindowsPowerShellHookCommand('Write-Output "ok"');

    expect(command.startsWith(`cmd.exe /d /c echo ${NEXUS_HOOK_MARKER}>NUL&&powershell.exe `)).toBe(
      true
    );
  });

  it('filterUserHooks drops marker-bearing entries and keeps user hooks', () => {
    const ours = { hooks: [{ type: 'command', command: makeStdinHookCommand('stop') }] };
    const theirs = { hooks: [{ type: 'command', command: 'echo user-stop' }] };

    expect(filterUserHooks([ours, theirs])).toEqual([theirs]);
  });
});
