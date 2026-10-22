import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimUiKitProjectWrite, resetUiKitProjectWritesForTests, runUiKitCli } from './ui-kit-cli';
import { callMcpToolOnce } from './ui-kit-mcp-call';
import { runShadcnCommand } from './ui-kit-service';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('./ui-kit-operator-keys', () => ({
  OPERATOR_BOARDUI_LICENSE_KEY: '', hasOperatorBoardUiLicenseKey: () => false,
  operatorBoardUiLicenseFile: () => { throw new Error('no licence access'); },
  operatorRegistryNamespaces: () => [], operatorRegistryToken: () => null,
}));

const PID = 41234; // Deliberately defined; every OS interaction is intercepted.
function child(pid: number | undefined = PID) {
  return Object.assign(new EventEmitter(), {
    pid, exitCode: null, signalCode: null, kill: vi.fn(() => true),
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  }) as unknown as ReturnType<typeof spawn>;
}
let cwd = '';
let vendor: ReturnType<typeof spawn>;
let killer: ReturnType<typeof spawn>;
let controller: AbortController;
let killOutcome: 'error' | 'nonzero' | 'missing' | 'zero' | 'hang';
beforeEach(() => {
  vi.useFakeTimers();
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kit-lifetime-'));
  vendor = child(); killer = child(51234); controller = new AbortController();
  killOutcome = 'nonzero';
  vi.mocked(spawn).mockImplementation(command => {
    if (!String(command).endsWith('taskkill.exe')) return vendor;
    queueMicrotask(() => {
      if (killOutcome === 'error') killer.emit('error', new Error('taskkill EACCES'));
      else if (killOutcome !== 'hang') killer.emit('close', killOutcome === 'zero' ? 0 : killOutcome === 'missing' ? 128 : 1);
    });
    return killer;
  });
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(spawn).mockReset();
  resetUiKitProjectWritesForTests();
  fs.rmSync(cwd, { recursive: true, force: true });
});
type Runner = 'cli' | 'mcp' | 'service';
function start(runner: Runner, platform: NodeJS.Platform = 'win32') {
  const common = { cwd, writes: true, signal: controller.signal };
  const call = runner === 'cli' ? runUiKitCli({ ...common, kit: 'boardui', args: ['add', 'button'] })
    : runner === 'mcp' ? callMcpToolOnce({ ...common, kit: 'boardui', method: 'tools/call', tool: 'install_components' }, { platform })
      : runShadcnCommand({ cwd, signal: controller.signal, command: { kind: 'add', items: ['button'] } }, {
        registries: () => [], getSecret: () => null, setSecret: () => ({ ok: true }),
      });
  // Observe rejection immediately; logical failure must settle within a bound.
  return call.then(value => ({ value, error: undefined }), error => ({ error, value: undefined }));
}
function busy() { expect(() => claimUiKitProjectWrite(cwd)).toThrow(/still running/); }
function free() { const release = claimUiKitProjectWrite(cwd); release(); }
function closeVendor() {
  vendor.emit('exit', 0, null);
  Object.assign(vendor, { exitCode: 0 });
  vendor.emit('close', 0, null);
}
function mcpResult() {
  vendor.stdout?.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n'));
  vendor.stdout?.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2,
    result: { content: [{ type: 'text', text: 'installed' }] } }) + '\n'));
}

describe.skipIf(process.platform !== 'win32')('F-1641 defined-PID physical lifetime', () => {
  it.each(['cli', 'mcp', 'service'] as const)('%s retains its claim after nonzero taskkill and late root close', async runner => {
    const call = start(runner); controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).error).toMatchObject({ code: 'TEARDOWN_FAILED' });
    busy(); closeVendor(); await vi.advanceTimersByTimeAsync(1); busy();
    expect(vi.mocked(spawn).mock.calls.filter(([cmd]) => String(cmd).endsWith('taskkill.exe'))).toHaveLength(1);
  });
  it.each(['error', 'hang', 'missing'] as const)('taskkill %s fails finitely and retains exclusivity', async outcome => {
    killOutcome = outcome;
    const call = start('cli'); controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).error).toMatchObject({ code: 'TEARDOWN_FAILED' }); busy();
  });
  it('MCP success is not success when teardown fails', async () => {
    const call = start('mcp'); mcpResult();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).error).toMatchObject({ code: 'TEARDOWN_FAILED' }); busy();
  });
  it.each(['cli', 'mcp', 'service'] as const)('%s requires exact child close even after successful taskkill', async runner => {
    killOutcome = 'zero'; const call = start(runner); controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).error).toMatchObject({ code: 'TEARDOWN_FAILED' }); busy();
    closeVendor(); await vi.advanceTimersByTimeAsync(1); free();
  });
  it('successful teardown plus exact close releases the MCP writer', async () => {
    killOutcome = 'zero'; const call = start('mcp'); mcpResult();
    await vi.advanceTimersByTimeAsync(1); busy();
    closeVendor(); await vi.advanceTimersByTimeAsync(1);
    expect((await call).value).toMatchObject({ text: 'installed' }); free();
  });
  it('an error after spawn does not prove exit or release the CLI claim', async () => {
    const call = start('cli'); vendor.emit('error', new Error('late child error'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).error).toMatchObject({ code: 'TEARDOWN_FAILED' }); busy();
  });
  it('does not taskkill a numeric PID after the owned root has exited', async () => {
    const call = start('mcp'); vendor.emit('exit', 0, null); mcpResult();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).error).toMatchObject({ code: 'TEARDOWN_FAILED' }); busy();
    expect(vi.mocked(spawn).mock.calls.filter(([cmd]) => String(cmd).endsWith('taskkill.exe'))).toHaveLength(0);
  });
  it('a failed spawn without a PID has no physical writer to retain', async () => {
    Object.assign(vendor, { pid: undefined });
    const call = start('cli'); vendor.emit('error', new Error('ENOENT'));
    await vi.advanceTimersByTimeAsync(1);
    expect((await call).error).toMatchObject({ code: 'SPAWN_FAILED' }); free();
  });
  it('does not release if root close arrives before a failing taskkill result', async () => {
    const call = start('cli'); controller.abort(); closeVendor();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).error).toMatchObject({ code: 'TEARDOWN_FAILED' }); busy();
  });
});

describe('F-1641 detached POSIX group proof', () => {
  it('a successful signal syscall does not prove the group disappeared', async () => {
    vi.mocked(process.kill).mockReturnValue(true);
    const call = start('mcp', 'linux'); mcpResult();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).error).toMatchObject({ code: 'TEARDOWN_FAILED' }); busy();
  });
  it('does not escalate a numeric group after its owned leader exits', async () => {
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') closeVendor();
      return true;
    });
    const call = start('mcp', 'linux'); mcpResult();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).error).toMatchObject({ code: 'TEARDOWN_FAILED' }); busy();
    expect(vi.mocked(process.kill).mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false);
  });
  it('permission failures retain the claim even when the owned leader later closes', async () => {
    const call = start('mcp', 'linux'); controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).error).toMatchObject({ code: 'TEARDOWN_FAILED' });
    closeVendor(); await vi.advanceTimersByTimeAsync(1); busy();
  });
  it('group absence plus exact close proves a completed teardown', async () => {
    let gone = false;
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') { gone = true; closeVendor(); }
      if (signal === 0 && gone) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    });
    const call = start('mcp', 'linux'); mcpResult();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).value).toMatchObject({ text: 'installed' }); free();
  });
});
