// @vitest-environment node
import { spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { resetUiKitProjectWritesForTests } from '../ui-kit/ui-kit-cli';

vi.mock('node:child_process', () => {
  const refuse = () => { throw new Error('no external process in this fixture'); };
  return { spawn: vi.fn(), spawnSync: refuse, exec: refuse, execFile: refuse, execFileSync: refuse };
});
// Never load the bundled credentials or read the operator's vault/config.
vi.mock('../ui-kit/ui-kit-operator-keys', () => ({
  OPERATOR_BOARDUI_LICENSE_KEY: '',
  hasOperatorBoardUiLicenseKey: () => false,
  operatorBoardUiLicenseFile: () => { throw new Error('no licence access in this fixture'); },
  operatorRegistryNamespaces: () => [],
  operatorRegistryToken: () => null,
}));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: () => ({ uiKitRegistries: [
    { namespace: '@fixture', url: 'https://registry.example.test/{name}.json' },
  ] }),
}));
// Dependency injection ONLY for vault/file boundaries. Handlers, execution
// scope resolution, services, registry writes, runners and claims stay real.
vi.mock('../ui-kit/ui-kit-service', async importOriginal => {
  const actual = await importOriginal<typeof import('../ui-kit/ui-kit-service')>();
  const privateDeps = {
    getSecret: () => null,
    setSecret: () => ({ ok: true }),
    boardUiLicenseFile: {
      read: () => { throw new Error('no licence access in this fixture'); },
      write: () => { throw new Error('no licence access in this fixture'); },
      remove: () => { throw new Error('no licence access in this fixture'); },
    },
  };
  return {
    ...actual,
    installItems: (input: Parameters<typeof actual.installItems>[0], deps: Parameters<typeof actual.installItems>[1]) =>
      actual.installItems(input, { ...deps, ...privateDeps }),
    runShadcnCommand: (input: Parameters<typeof actual.runShadcnCommand>[0], deps: Parameters<typeof actual.runShadcnCommand>[1]) =>
      actual.runShadcnCommand(input, { ...deps, ...privateDeps }),
    callBoardUiTool: (input: Parameters<typeof actual.callBoardUiTool>[0], deps: Parameters<typeof actual.callBoardUiTool>[1]) =>
      actual.callBoardUiTool(input, { ...deps, ...privateDeps }),
  };
});

const { buildUiKitTools } = await import('./tools-ui-kit');

const actions = {
  shadcn: { name: 'nexus_ui_kit_add', args: { kit: 'shadcn', items: ['@fixture/button'] } },
  init: { name: 'nexus_ui_kit_run', args: { command: 'init' } },
  boardui: { name: 'nexus_ui_kit_add', args: { kit: 'boardui', items: ['button'] } },
  mcp: { name: 'nexus_ui_kit_boardui', args: { tool: 'install_components', args: { components: ['button'] } } },
  task: { name: 'nexus_ui_kit_add', args: { kit: 'shadcn', task: 'login form' } },
  recipe: { name: 'nexus_ui_kit_recipe', args: { kit: 'shadcn', recipe: 'auth' } },
} as const;
type Action = keyof typeof actions;
let fixture = '';
let root = '';
let ctx: AgentGateContext;
const children: Array<{ child: ReturnType<typeof spawn>; finish: () => void }> = [];

function pkg(dir: string, value: Record<string, unknown> = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(value));
  fs.writeFileSync(path.join(dir, 'components.json'), '{}\n');
}

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kit-handler-root-'));
  root = path.join(fixture, 'execution');
  pkg(root, { private: true, workspaces: ['apps/*'] });
  pkg(path.join(root, 'apps/one'), { name: 'one' });
  pkg(path.join(root, 'apps/two'), { name: 'two' });
  const coordination = path.join(fixture, 'coordination');
  pkg(coordination);
  ctx = { scope: { rootRealPath: coordination }, executionScope: { rootRealPath: root } } as AgentGateContext;
  vi.mocked(spawn).mockImplementation((_command, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined,
    }) as unknown as ReturnType<typeof spawn>;
    if (args?.includes('search')) {
      const stdio = (options as SpawnOptions).stdio;
      const fd = Array.isArray(stdio) ? stdio[1] : undefined;
      if (typeof fd !== 'number') throw new Error('expected file capture for search');
      fs.writeSync(fd, JSON.stringify({ items: [
        { name: 'login', registry: '@shadcn', type: 'registry:block' },
        { name: 'input', registry: '@shadcn', type: 'registry:ui' },
      ] }));
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }
    const mcp = args?.includes('mcp');
    child.stdin?.on('data', (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString()) as { id?: number; method: string };
      if (message.method === 'initialize') child.stdout?.emit('data', Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }) + '\n'));
    });
    let finished = false;
    children.push({ child, finish: () => {
      if (finished) return;
      finished = true;
      if (mcp) child.stdout?.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: 'installed' }] } }) + '\n'));
      else child.emit('close', 0);
    } });
    return child;
  });
});
afterEach(() => {
  for (const entry of children) entry.finish();
  children.length = 0;
  resetUiKitProjectWritesForTests();
  vi.resetAllMocks();
  fs.rmSync(fixture, { recursive: true, force: true });
});

function call(action: Action, workspace: string | undefined = 'apps/one', context = ctx) {
  const { name, args } = actions[action];
  const tool = buildUiKitTools().find(entry => entry.name === name)!;
  return tool.handler({ ...args, ...(workspace ? { workspace } : {}) }, context);
}

describe('Main execution root through the public UI-kit handler and service', () => {
  it.each(['shadcn', 'init', 'boardui', 'mcp', 'task', 'recipe'] as const)('%s refuses a root junction before vendor or config writes', async action => {
    const shared = path.join(fixture, 'shared');
    fs.mkdirSync(shared);
    fs.symlinkSync(shared, path.join(root, 'node_modules'), 'junction');
    // Fail fast even on the unfixed code, without launching any vendor.
    vi.mocked(spawn).mockImplementation(() => { throw new Error('vendor must not start'); });
    await expect(call(action)).rejects.toMatchObject({ code: 'SHARED_NODE_MODULES' });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, 'apps/one/components.json'), 'utf8')).toBe('{}\n');
  });

  it.each([
    ['shadcn', 'shadcn'], ['shadcn', 'mcp'], ['mcp', 'shadcn'],
    ['boardui', 'mcp'], ['mcp', 'boardui'], ['init', 'mcp'],
    ['recipe', 'mcp'], ['mcp', 'recipe'],
  ] as const)('%s holds the installation against sibling %s until completion', async (firstAction, secondAction) => {
    const first = call(firstAction);
    void first.catch(() => {});
    await vi.waitFor(() => expect(children).toHaveLength(1));
    if (firstAction === 'shadcn') {
      expect(JSON.parse(fs.readFileSync(path.join(root, 'apps/one/components.json'), 'utf8')).registries)
        .toEqual({ '@fixture': 'https://registry.example.test/{name}.json' });
      expect(fs.readFileSync(path.join(root, 'components.json'), 'utf8')).toBe('{}\n');
    }
    // Unexpected second admission fails fast instead of leaving a test hung.
    const spawnFirst = vi.mocked(spawn).getMockImplementation()!;
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if (args?.includes('search')) return spawnFirst(command, args, options);
      throw new Error('sibling writer must not start');
    });
    try {
      await expect(call(secondAction, 'apps/two')).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      expect(vi.mocked(spawn).mock.calls.filter(([, args]) => !args?.includes('search'))).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, 'apps/two/components.json'), 'utf8')).toBe('{}\n');
      await expect(call(secondAction, '')).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    } finally {
      children[0]!.finish();
      await first;
    }
    vi.mocked(spawn).mockImplementation(spawnFirst);
    const retry = call(secondAction, 'apps/two');
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.finish();
    await expect(retry).resolves.toMatchObject({ ok: true });
  });

  it('leaves a nested independent project concurrent and uses execution, not coordination, authority', async () => {
    const independent = path.join(root, 'independent');
    pkg(independent);
    const first = call('shadcn');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const other = call('shadcn', '', { ...ctx, executionScope: { ...ctx.executionScope!, rootRealPath: independent } });
    void other.catch(() => {});
    try {
      await vi.waitFor(() => expect(children).toHaveLength(2));
      const firstArgs = vi.mocked(spawn).mock.calls[0]![1] as string[];
      expect(firstArgs.slice(-2)).toEqual(['--cwd', path.join(root, 'apps/one')]);
      const otherArgs = vi.mocked(spawn).mock.calls[1]![1] as string[];
      expect(otherArgs.slice(-2)).toEqual(['--cwd', independent]);
    } finally {
      children.forEach(entry => entry.finish());
      await Promise.all([first, other]);
    }
  });
});
