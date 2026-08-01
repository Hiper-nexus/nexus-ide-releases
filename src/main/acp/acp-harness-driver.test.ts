/**
 * Integration tests for the production ACP harness driver (fake peer subprocess).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PRESET_HARNESSES } from '../../shared/harness-catalog';
import type { ObserverFrameInput } from '../../shared/observer-frame';
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
});
