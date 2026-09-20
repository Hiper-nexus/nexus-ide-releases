/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  notifyPaneWorkspaceReveal,
  paneIntersectionApplies,
  paneSlotIsLaidOut,
  subscribePaneWorkspaceReveal,
} from './pane-intersection';

describe('paneSlotIsLaidOut — F-603', () => {
  it('keeps a 0×0 box (hidden workspace) from counting as off-screen', () => {
    expect(paneSlotIsLaidOut({ width: 0, height: 0 })).toBe(false);
  });

  it('treats a real mosaic tile as laid out, even if tiny', () => {
    expect(paneSlotIsLaidOut({ width: 12, height: 8 })).toBe(true);
  });
});

describe('paneIntersectionApplies — F-603', () => {
  it('ignores a laid-out slot inside a hidden workspace', () => {
    const workspace = document.createElement('section');
    workspace.hidden = true;
    const slot = document.createElement('div');
    workspace.appendChild(slot);
    document.body.appendChild(workspace);
    expect(
      paneIntersectionApplies({
        boundingClientRect: { width: 800, height: 600 },
        target: slot,
      }),
    ).toBe(false);
    workspace.remove();
  });

  it('applies to a laid-out slot in a visible workspace', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    expect(
      paneIntersectionApplies({
        boundingClientRect: { width: 800, height: 600 },
        target: slot,
      }),
    ).toBe(true);
    slot.remove();
  });
});

describe('pane workspace reveal — F-603', () => {
  it('notifies subscribers once per reveal', () => {
    const seen: number[] = [];
    const stop = subscribePaneWorkspaceReveal(() => seen.push(1));
    notifyPaneWorkspaceReveal();
    notifyPaneWorkspaceReveal();
    stop();
    notifyPaneWorkspaceReveal();
    expect(seen).toEqual([1, 1]);
  });
});
