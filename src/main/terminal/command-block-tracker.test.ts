import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandBlockTracker,
  resetCommandBlockTrackingForTests,
} from './command-block-tracker';

afterEach(() => {
  resetCommandBlockTrackingForTests();
});

describe('CommandBlockTracker', () => {
  it('builds blocks from OSC 133 lifecycle without requiring shell integration always', () => {
    const finished: string[] = [];
    const tracker = new CommandBlockTracker({
      isEnabled: () => true,
      now: (() => {
        let t = 1000;
        return () => {
          t += 10;
          return t;
        };
      })(),
      onBlock: (b) => finished.push(b.command),
    });

    tracker.bindSession('sess-1', {
      paneId: 'pane-1',
      workspaceId: 'ws-1',
      shell: '/bin/zsh',
      cwd: '/workspace',
      projectRoot: '/workspace',
      gitBranch: 'main',
    });

    // No integration → no blocks, no throw.
    tracker.handleData('sess-1', 'plain output\n');
    expect(tracker.listBlocks('sess-1')).toEqual([]);

    const stream =
      '\x1b]133;A\x07' +
      '\x1b]133;B\x07' +
      '\x1b]133;E;echo hello\x07' +
      '\x1b]133;C\x07' +
      'hello\n' +
      '\x1b]133;D;0\x07';
    tracker.handleData('sess-1', stream);

    const blocks = tracker.listBlocks('sess-1');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      command: 'echo hello',
      status: 'success',
      exitCode: 0,
    });
    expect(finished).toEqual(['echo hello']);
  });

  it('redacts secrets before exposing command text', () => {
    const tracker = new CommandBlockTracker({
      isEnabled: () => true,
      now: () => 50,
    });
    tracker.bindSession('s', {
      paneId: 'p',
      workspaceId: 'w',
      shell: 'zsh',
      cwd: '/tmp',
    });
    tracker.handleData(
      's',
      '\x1b]133;E;curl -H "Authorization: Bearer super.secret.token" https://x\x07' +
        '\x1b]133;C\x07\x1b]133;D;0\x07',
    );
    const block = tracker.listBlocks('s')[0];
    expect(block?.command).not.toContain('super.secret');
    expect(block?.command).toContain('[REDACTED]');
  });

  it('is inert when feature flag is disabled', () => {
    const tracker = new CommandBlockTracker({ isEnabled: () => false });
    tracker.bindSession('s', {
      paneId: 'p',
      workspaceId: 'w',
      shell: 'zsh',
      cwd: '/tmp',
    });
    tracker.handleData(
      's',
      '\x1b]133;E;echo x\x07\x1b]133;C\x07\x1b]133;D;0\x07',
    );
    expect(tracker.listBlocks('s')).toEqual([]);
  });

  it('lists blocks by pane across sessions', () => {
    const tracker = new CommandBlockTracker({
      isEnabled: () => true,
      now: () => 100,
    });
    tracker.bindSession('s1', {
      paneId: 'pane-a',
      workspaceId: 'w',
      shell: 'zsh',
      cwd: '/tmp',
    });
    tracker.bindSession('s2', {
      paneId: 'pane-b',
      workspaceId: 'w',
      shell: 'zsh',
      cwd: '/tmp',
    });
    tracker.handleData(
      's1',
      '\x1b]133;E;echo a\x07\x1b]133;C\x07\x1b]133;D;0\x07',
    );
    tracker.handleData(
      's2',
      '\x1b]133;E;echo b\x07\x1b]133;C\x07\x1b]133;D;0\x07',
    );
    expect(tracker.listByPane('pane-a').map((b) => b.command)).toEqual([
      'echo a',
    ]);
    expect(tracker.listByPane('pane-b')).toHaveLength(1);
    expect(tracker.listByPane('missing')).toEqual([]);
  });
});
