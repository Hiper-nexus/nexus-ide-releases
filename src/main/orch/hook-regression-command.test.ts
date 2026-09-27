import { describe, expect, it } from 'vitest';
import { makeRegressionHookCommand, REGRESSION_HOOK_TRANSPORT_SECONDS } from './hook-regression-command';

describe('makeRegressionHookCommand', () => {
  it('posix: posta o payload, devolve a resposta e nunca falha', () => {
    const cmd = makeRegressionHookCommand('darwin');
    expect(cmd).toContain('$NEXUS_HOOK_REGRESSION_URL');
    expect(cmd).toContain('Bearer $NEXUS_GATE_TOKEN');
    expect(cmd).toContain('--data-binary @-');
    expect(cmd).toContain(`--max-time ${REGRESSION_HOOK_TRANSPORT_SECONDS}`);
    expect(cmd).not.toContain('/dev/null');
    expect(cmd.trim().endsWith('|| true')).toBe(true);
  });

  it('windows: sai calado sem URL/token', () => {
    const cmd = makeRegressionHookCommand('win32');
    const script = Buffer.from(cmd.split('-EncodedCommand ')[1]!, 'base64').toString('utf16le');
    expect(script).toContain('if (-not $env:NEXUS_HOOK_REGRESSION_URL -or -not $env:NEXUS_GATE_TOKEN) { exit 0 }');
    expect(script).toContain('catch { exit 0 }');
  });
});
