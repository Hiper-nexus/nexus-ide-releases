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
});
