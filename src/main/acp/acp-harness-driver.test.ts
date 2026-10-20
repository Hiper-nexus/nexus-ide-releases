import { resetLicensedAccessMock } from '../__tests__/licensed-access';
beforeEach(resetLicensedAccessMock);
import { beforeEach } from 'vitest';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
import { requireAccess } from '../license-access';
import { primeSystemMemoryCacheForTest } from '../orch/pane-admission';
import { vi } from 'vitest';
/**
 * Integration tests for the production ACP harness driver (fake peer subprocess).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PRESET_HARNESSES } from '../../shared/harness-catalog';
import type { ObserverFrameInput } from '../../shared/observer-frame';
import { readSessionOutput } from '../orch/pane-session-output';
import {
  resetAcpDriverSessionsForTests,
  spawnAcpHarnessSession,
} from './acp-harness-driver';

const FAKE_PEER_SOURCE = `
import readline from 'node:readline';
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method } = msg;
  if (method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: 'driver-fake', version: '0.0.1' },
    } });
    return;
  }
  if (method === 'session/new') {
    write({ jsonrpc: '2.0', id, result: { sessionId: 'ses_driver' } });
    return;
  }
  if (method === 'session/prompt') {
    const prompt = msg.params.prompt.map((part) => part.text).join('');
    const update = (sessionId, value) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
    if (prompt === 'stream-proof') {
      update('foreign-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign response' } });
      update('ses_driver', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought summary' } });
      update('ses_driver', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } });
      update('ses_driver', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
    }
    if (prompt === 'large-stream-proof') {
      update('ses_driver', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(300_000) + 'response end' } });
    }
    if (prompt === 'boundary-hello' || prompt === 'boundary-world') {
      const chunks = prompt === 'boundary-hello' ? ['he', 'llo'] : ['wor', 'ld'];
      for (const text of chunks) {
        update('ses_driver', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      }
    }
    if (prompt === 'boundary-empty') {
      update('ses_driver', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } });
      update('ses_driver', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought-only turn' } });
    }
    write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  }
});
`;

let fixtureDir = '';
let fakePeerPath = '';

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-acp-driver-'));
  fakePeerPath = path.join(fixtureDir, 'fake-peer.mjs');
  await writeFile(fakePeerPath, FAKE_PEER_SOURCE, 'utf8');
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

test('mission authority activates RAM admission only for automatic workers', async () => {
  vi.stubEnv('NEXUS_PANE_GUARD', '');
  // Memória BAIXA mas não crítica (abaixo da reserva de 3.686 MB num Mac de
  // 24 GB, acima dos 30 % que são o limiar crítico): é aqui que vale a
  // distinção "só worker automático respeita o orçamento de RAM". Com 1 MB
  // livre, de 19/10 em diante NINGUÉM entra — ver o teste seguinte.
  primeSystemMemoryCacheForTest({ freeMB: 2_000, swapUsedMB: 0 });
  const base = {
    harness: { ...PRESET_HARNESSES[0], command: process.execPath, args: [fakePeerPath] },
    cwd: fixtureDir, paneId: 'resource-pane', missionId: 'resource-mission',
    scope: { version: 1 as const, installationId: 'install-test', projectId: 'p', checkoutId: 'c', rootRealPath: fixtureDir, identitySource: 'manifest' as const },
    publishFrame: () => {},
  };
  try {
    await expect(spawnAcpHarnessSession(base)).rejects.toThrow(/Memória/);
    for (const override of [{ role: 'orchestrator' as const }, { role: 'worker' as const, operatorOpened: true as const }]) {
      const session = await spawnAcpHarnessSession({ ...base, ...override });
      await session.shutdown();
    }
  } finally { vi.unstubAllEnvs(); primeSystemMemoryCacheForTest(null); }
});

test('pressão CRÍTICA recusa qualquer spawn ACP, inclusive orquestrador e pane do operador', async () => {
  // 19/10, cliente iMac M5 16 GB: na beira do freeze um pane novo (~1,25 GB)
  // leva o sistema inteiro. A recusa é uniforme de propósito — consequência
  // assumida: a remontagem de um orquestrador espera a folga voltar (o freio
  // de emergência do guardião está drenando em paralelo, a 5 s por varredura).
  vi.stubEnv('NEXUS_PANE_GUARD', '');
  primeSystemMemoryCacheForTest({ freeMB: 1, swapUsedMB: 0 });
  const base = {
    harness: { ...PRESET_HARNESSES[0], command: process.execPath, args: [fakePeerPath] },
    cwd: fixtureDir, paneId: 'critical-pane', missionId: 'critical-mission',
    scope: { version: 1 as const, installationId: 'install-test', projectId: 'p', checkoutId: 'c', rootRealPath: fixtureDir, identitySource: 'manifest' as const },
    publishFrame: () => {},
  };
  try {
    for (const override of [
      {},
      { role: 'orchestrator' as const },
      { role: 'worker' as const, operatorOpened: true as const },
    ]) {
      await expect(spawnAcpHarnessSession({ ...base, ...override })).rejects.toThrow(
        /Mem[óo]ria RAM cr[íi]tica/,
      );
    }
    // A válvula de escape continua valendo.
    vi.stubEnv('NEXUS_PANE_GUARD', 'off');
    const session = await spawnAcpHarnessSession({ ...base, role: 'orchestrator' as const });
    await session.shutdown();
  } finally { vi.unstubAllEnvs(); primeSystemMemoryCacheForTest(null); }
});

describe('acp-harness-driver', () => {
  test('spawn publishes session_spawned and completes a prompt turn', async () => {
    resetAcpDriverSessionsForTests();
    const frames: ObserverFrameInput[] = [];
    const harness = {
      ...PRESET_HARNESSES[0],
      command: process.execPath,
      args: [fakePeerPath],
    };
    const session = await spawnAcpHarnessSession({
      harness,
      cwd: fixtureDir,
      paneId: 'pane-1',
      missionId: 'mission-1',
      scope: {
        version: 1,
        installationId: 'install-test',
        projectId: 'p',
        checkoutId: 'c',
        rootRealPath: fixtureDir,
        identitySource: 'manifest',
      },
      publishFrame: (frame) => frames.push(frame),
    });
    expect(session.sessionId.startsWith('acp-')).toBe(true);
    expect(frames.some((f) => f.kind === 'session_spawned')).toBe(true);
    await session.prompt('hello');
    expect(frames.some((f) => f.kind === 'turn_started')).toBe(true);
    expect(frames.some((f) => f.kind === 'turn_ended')).toBe(true);
    await session.shutdown();
    expect(frames.some((f) => f.kind === 'session_exited')).toBe(true);
  });

  test('retains public response chunks for session read without thought or foreign-session text', async () => {
    const session = await spawnAcpHarnessSession({
      harness: { ...PRESET_HARNESSES[0], command: process.execPath, args: [fakePeerPath] },
      cwd: fixtureDir,
      paneId: 'pane-stream',
      missionId: 'mission-stream',
      scope: { version: 1, installationId: 'install-test', projectId: 'p', checkoutId: 'c', rootRealPath: fixtureDir, identitySource: 'manifest' },
      publishFrame: () => {},
    });
    try {
      expect(readSessionOutput(session.sessionId)).toBe('');
      await session.prompt('stream-proof');
      expect(readSessionOutput(session.sessionId)).toBe('hello world');
      expect(readSessionOutput('foreign-session')).toBe('');
    } finally {
      await session.shutdown();
    }
  });

  test('separates responses across turns while preserving chunks and empty-turn output', async () => {
    const session = await spawnAcpHarnessSession({
      harness: { ...PRESET_HARNESSES[0], command: process.execPath, args: [fakePeerPath] },
      cwd: fixtureDir,
      paneId: 'pane-turn-boundaries',
      missionId: 'mission-turn-boundaries',
      scope: { version: 1, installationId: 'install-test', projectId: 'p', checkoutId: 'c', rootRealPath: fixtureDir, identitySource: 'manifest' },
      publishFrame: () => {},
    });
    try {
      await session.prompt('boundary-hello');
      expect(readSessionOutput(session.sessionId)).toBe('hello');
      await session.prompt('boundary-empty');
      expect(readSessionOutput(session.sessionId)).toBe('hello');
      await session.prompt('boundary-world');
      expect(readSessionOutput(session.sessionId)).toBe('hello\n\nworld');
    } finally {
      await session.shutdown();
    }
  });

  test('retains a bounded tail when one valid response chunk exceeds the pane ring', async () => {
    const session = await spawnAcpHarnessSession({
      harness: { ...PRESET_HARNESSES[0], command: process.execPath, args: [fakePeerPath] },
      cwd: fixtureDir,
      paneId: 'pane-large-stream',
      missionId: 'mission-large-stream',
      scope: { version: 1, installationId: 'install-test', projectId: 'p', checkoutId: 'c', rootRealPath: fixtureDir, identitySource: 'manifest' },
      publishFrame: () => {},
    });
    try {
      await session.prompt('large-stream-proof');
      const output = readSessionOutput(session.sessionId);
      expect(output).toMatch(/x+response end$/);
      expect(output.length).toBeLessThanOrEqual(262_144);
    } finally {
      await session.shutdown();
    }
  });
});


test('driver rejects denied access before starting a harness', async () => {
  vi.mocked(requireAccess).mockReturnValue({ ok: false, reason: 'inactive' });
  await expect(spawnAcpHarnessSession({} as never)).rejects.toMatchObject({ code: 'license_access_denied' });
});
