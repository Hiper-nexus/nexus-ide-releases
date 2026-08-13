import { describe, expect, it, vi } from 'vitest';
import { notifyDesktopAttention } from './desktop-attention-ping';

describe('notifyDesktopAttention', () => {
  it('pinga só estados que pedem ação humana', () => {
    const notify = vi.fn();
    expect(
      notifyDesktopAttention({ kind: 'completed', agentLabel: 'Claude', notify }),
    ).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      'Nexus',
      'Claude terminou e espera sua revisão.',
    );
    notify.mockClear();
    expect(
      notifyDesktopAttention({ kind: 'exited', agentLabel: 'Claude', notify }),
    ).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});
