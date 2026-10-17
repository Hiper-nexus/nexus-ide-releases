import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { summarizeUsage, usageWindowStartDay } from '../../shared/usage-analytics';
import type { UsageAnalytics, UsageSnapshot } from '../../shared/usage-types';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { UsageTelemetryService, tapUsageSnapshot } from './usage-service';
import { ProjectUsageStoreRegistry } from './usage-store-registry';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

let sqliteAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- sonda: o better-sqlite3 pode estar compilado para o ABI do Electron; o require no try decide se a suíte roda
  const Database = require('better-sqlite3') as new (file: string) => { close(): void };
  new Database(':memory:').close();
} catch {
  sqliteAvailable = false;
}

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const runtimeManager of managers.splice(0)) runtimeManager.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('UsageTelemetryService — releitura final do rollup', () => {
  it('um evento dentro do TTL não fica fora do painel quando a atividade para: o broadcast chega ao fim do minuto', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-refresh-'));
    roots.push(parent);
    const checkout = path.join(parent, 'checkout-a');
    fs.mkdirSync(checkout);
    const scope: ProjectExecutionScope = Object.freeze({
      version: 1,
      installationId: 'install-a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: fs.realpathSync(checkout),
      identitySource: 'manifest',
    });
    const runtimeManager = new ProjectRuntimeManager({
      baseDir: path.join(parent, 'runtime'),
      appVersion: 'usage-refresh-test',
    });
    managers.push(runtimeManager);
    const registry = new ProjectUsageStoreRegistry(runtimeManager);
    const usage = registry.forScope(scope).usage;
    const record = (messageId: string, outputTokens: number) =>
      usage.record('claude', {
        sessionId: 'session-a',
        messageId,
        model: 'claude-sonnet-4-5',
        inputTokens: 10,
        outputTokens,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        timestamp: Date.now(),
      });
    const service = new UsageTelemetryService(registry);
    const broadcasts: UsageSnapshot[] = [];
    const untap = tapUsageSnapshot((_scope, snapshot) => broadcasts.push(snapshot));
    const outputOf = (analytics: UsageAnalytics | undefined) =>
      summarizeUsage(analytics!, {
        from: usageWindowStartDay(analytics!.today, 30),
        to: analytics!.today,
      }).totals.outputTokens;

    // t=0: primeiro evento e primeiro broadcast (o rollup é calculado agora).
    record('a', 2);
    service.notifyMediaGenerated(scope);
    vi.advanceTimersByTime(1_000);
    expect(broadcasts).toHaveLength(1);
    expect(outputOf(broadcasts[0]!.analytics)).toBe(2);

    // t=30 s: mais um evento. O broadcast sai, mas o rollup ainda vale (dentro do minuto).
    vi.advanceTimersByTime(29_000);
    record('b', 5);
    service.notifyMediaGenerated(scope);
    vi.advanceTimersByTime(1_000);
    expect(broadcasts).toHaveLength(2);
    expect(outputOf(broadcasts[1]!.analytics)).toBe(2);

    // A atividade para. Ao fim do TTL o painel recebe o rollup com o último evento.
    vi.advanceTimersByTime(40_000);
    expect(broadcasts.length).toBeGreaterThanOrEqual(3);
    expect(outputOf(broadcasts.at(-1)!.analytics)).toBe(7);

    // Rollup em dia: nenhuma releitura nova fica armada — o relógio só roda de novo com evento.
    const settled = broadcasts.length;
    vi.advanceTimersByTime(5 * 60_000);
    expect(broadcasts).toHaveLength(settled);
    untap();
    service.stop();
  });
});
