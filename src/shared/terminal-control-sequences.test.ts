import { describe, expect, it } from 'vitest';
import { stripTerminalControlSequences } from './terminal-control-sequences';

describe('stripTerminalControlSequences', () => {
  it('removes CSI and OSC title sequences terminated by BEL or ST', () => {
    expect(
      stripTerminalControlSequences(
        '\u001b]0;PowerShell\u0007left\u001b[32m \u001b[0mright',
      ),
    ).toBe('left right');
    expect(
      stripTerminalControlSequences(
        '\u001b]2;PowerShell\u001b\\left right',
      ),
    ).toBe('left right');
  });

  it('removes a ConPTY OSC title containing a Windows executable path', () => {
    expect(
      stripTerminalControlSequences(
        'codex-cli 0.145.0\r\n\u001b]0;D:\\a\\_temp\\nexus-smoke-cli\\codex.exe\u0007',
      ).trim(),
    ).toBe('codex-cli 0.145.0');
  });
});
