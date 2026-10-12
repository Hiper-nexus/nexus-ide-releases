import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandBlockTracker,
  resetCommandBlockTrackingForTests,
} from './command-block-tracker';
import type { CommandBlock } from '../../shared/command-block';
import {
  registerCommandBlockScope,
  resolveCommandBlockScope,
  resetCommandBlockScopeRegistryForTests,
} from './command-block-scope-registry';
import { testProjectScope } from '../orch/__tests__/scope-fixture';

afterEach(() => {
  resetCommandBlockTrackingForTests();
  resetCommandBlockScopeRegistryForTests();
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

  it('exposes an immutable Main-owned context for refinery authorization', () => {
    const tracker = new CommandBlockTracker({ isEnabled: () => true });
    tracker.bindSession('s1', {
      paneId: 'pane-a',
      workspaceId: 'checkout-a',
      shell: 'zsh',
      cwd: '/workspace',
      projectRoot: '/workspace',
      gitBranch: 'feat/refinery',
    });
    tracker.handleData('s1', '\x1b]133;P;Cwd=/workspace/packages/ui\x07');

    const context = tracker.getSessionContext('s1');
    expect(context).toEqual({
      paneId: 'pane-a',
      workspaceId: 'checkout-a',
      cwd: '/workspace/packages/ui',
      projectRoot: '/workspace',
      gitBranch: 'feat/refinery',
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('persists an unterminated running block as unknown on PTY exit', () => {
    const finished: Array<{ command: string; status: string }> = [];
    const tracker = new CommandBlockTracker({
      isEnabled: () => true,
      now: () => 50,
      onBlock: (block) => finished.push({
        command: block.command,
        status: block.status,
      }),
    });
    tracker.bindSession('s', {
      paneId: 'p', workspaceId: 'w', shell: 'zsh', cwd: '/tmp',
    });
    const scope = testProjectScope();
    registerCommandBlockScope('s', scope);
    tracker.handleData('s', '\x1b]133;E;npm test\x07\x1b]133;C\x07');
    tracker.handleExit('s');
    expect(finished).toEqual([{ command: 'npm test', status: 'unknown' }]);
    expect(tracker.listBlocks('s')).toEqual([]);
    expect(resolveCommandBlockScope('s')).toBeNull();
    expect(resolveCommandBlockScope('missing', scope.projectId)).toBeNull();
  });

  // F-1274: the bash DEBUG trap also fires for PROMPT_COMMAND, so the hook's
  // own 133;E must not stay pending and name the next command's block.
  it('does not let a hook command line received mid-command name the next block', () => {
    const finished: CommandBlock[] = [];
    const tracker = new CommandBlockTracker({ isEnabled: () => true, now: () => 1, onBlock: (b) => finished.push(b) });
    tracker.bindSession('s', { paneId: 'p', workspaceId: 'w', shell: 'bash', cwd: '/tmp' });
    // One full bash cycle (DEBUG trap order): command, then PROMPT_COMMAND's
    // own B/E/C before D, then the next command.
    tracker.handleData('s',
      '\x1b]133;B\x07\x1b]133;E;echo hi\x07\x1b]133;C\x07' +
      '\x1b]133;B\x07\x1b]133;E;__nexus_prompt_command\x07\x1b]133;C\x07' +
      '\x1b]133;D;0\x07\x1b]133;A\x07' +
      '\x1b]133;B\x07\x1b]133;E;echo hi2\x07\x1b]133;C\x07' +
      '\x1b]133;D;1\x07\x1b]133;A\x07');
    const blocks = tracker.listBlocks('s');
    expect(blocks.map((b) => [b.command, b.status])).toEqual([
      ['echo hi', 'success'],
      ['echo hi2', 'failed'],
    ]);
  });
});
