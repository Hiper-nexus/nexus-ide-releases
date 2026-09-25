import { describe, expect, it } from 'vitest';
import { makeDelegateHookCommand } from './hook-delegate-command';

describe('makeDelegateHookCommand', () => {
  it('posix: posta o payload, devolve a resposta e nunca falha', () => {
    const cmd = makeDelegateHookCommand('darwin');
    expect(cmd).toContain('$NEXUS_HOOK_DELEGATE_URL');
    expect(cmd).toContain('Bearer $NEXUS_GATE_TOKEN');
    expect(cmd).toContain('--data-binary @-');
    expect(cmd).toContain('--max-time 4');
    expect(cmd).not.toContain('/dev/null');
    expect(cmd.trim().endsWith('|| true')).toBe(true);
  });

  it('windows: sai calado sem URL/token', () => {
    const cmd = makeDelegateHookCommand('win32');
    // O script vai em -EncodedCommand (UTF-16LE base64): decodifica para ler.
    const script = Buffer.from(cmd.split('-EncodedCommand ')[1]!, 'base64').toString('utf16le');
    expect(script).toContain('if (-not $env:NEXUS_HOOK_DELEGATE_URL -or -not $env:NEXUS_GATE_TOKEN) { exit 0 }');
    expect(script).toContain('catch { exit 0 }');
  });
});
