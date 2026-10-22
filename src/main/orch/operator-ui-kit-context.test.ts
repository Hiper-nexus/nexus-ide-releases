import { describe, expect, it } from 'vitest';
import { operatorUiKitContext } from './operator-ui-kit-context';

describe('operatorUiKitContext', () => {
  it('reaches an operator pane whose CLI has no delegate hook', () => {
    const text = operatorUiKitContext({ role: 'user', missionId: undefined, providerId: 'grok' } as never, 'mcp');
    expect(text).toContain('nexus_ui_kit_add({task})');
  });

  it('stays out of a CLI that gets the charter through the hook', () => {
    expect(
      operatorUiKitContext({ role: 'user', missionId: undefined, providerId: 'claude' } as never, 'mcp'),
    ).toBeNull();
    expect(
      operatorUiKitContext({ role: 'user', missionId: undefined, providerId: 'codex' } as never, 'mcp'),
    ).toBeNull();
  });

  it('stays out of mission workers, which get it in their brief', () => {
    expect(
      operatorUiKitContext({ role: 'worker', missionId: 'm1', providerId: 'grok' } as never, 'mcp'),
    ).toBeNull();
  });
});
