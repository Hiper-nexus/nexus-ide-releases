import { describe, expect, it, vi } from 'vitest';
import type { MissionStatus } from '../../shared/orch-types';
import {
  startOrResumeMissionFromVoice,
  type VoiceMissionPorts,
} from './mission-voice-bridge';

function makePorts(
  seed: {
    id: string;
    status: MissionStatus;
    updatedAt: number;
    title?: string;
  }[] = [],
): VoiceMissionPorts & {
  created: { title: string; description?: string }[];
  statusCalls: { id: string; status: MissionStatus }[];
} {
  const missions = seed.map((m) => ({
    id: m.id,
    status: m.status,
    updatedAt: m.updatedAt,
    title: m.title ?? m.id,
  }));
  const created: { title: string; description?: string }[] = [];
  const statusCalls: { id: string; status: MissionStatus }[] = [];
  let nextId = 1;
  return {
    created,
    statusCalls,
    listMissions: () => missions,
    createMission: (input) => {
      created.push(input);
      const id = `voice-${nextId++}`;
      missions.push({
        id,
        status: 'pending',
        updatedAt: Date.now(),
        title: input.title,
      });
      return { id };
    },
    setStatus: (id, status) => {
      statusCalls.push({ id, status });
      const found = missions.find((m) => m.id === id);
      if (found) found.status = status;
    },
  };
}

describe('startOrResumeMissionFromVoice', () => {
  it('resume running mission when one exists (no create)', () => {
    const ports = makePorts([
      { id: 'm-run', status: 'running', updatedAt: 100 },
      { id: 'm-pend', status: 'pending', updatedAt: 200 },
    ]);
    const intent = startOrResumeMissionFromVoice(ports);
    expect(intent).toEqual({
      kind: 'resumed',
      missionId: 'm-run',
      fromStatus: 'running',
    });
    expect(ports.created).toEqual([]);
    expect(ports.statusCalls).toEqual([]);
  });

  it('resume blocked before pending, and sets running', () => {
    const ports = makePorts([
      { id: 'm-pend', status: 'pending', updatedAt: 300 },
      { id: 'm-block', status: 'blocked', updatedAt: 100 },
    ]);
    const intent = startOrResumeMissionFromVoice(ports);
    expect(intent).toEqual({
      kind: 'resumed',
      missionId: 'm-block',
      fromStatus: 'blocked',
    });
    expect(ports.statusCalls).toEqual([{ id: 'm-block', status: 'running' }]);
    expect(ports.created).toEqual([]);
  });

  it('picks most recently updated within the same tier', () => {
    const ports = makePorts([
      { id: 'old', status: 'pending', updatedAt: 10 },
      { id: 'new', status: 'pending', updatedAt: 99 },
    ]);
    const intent = startOrResumeMissionFromVoice(ports);
    expect(intent.kind).toBe('resumed');
    if (intent.kind === 'resumed') {
      expect(intent.missionId).toBe('new');
    }
  });

  it('starts a new mission when none are runnable (ignores done/failed)', () => {
    const ports = makePorts([
      { id: 'done', status: 'done', updatedAt: 50 },
      { id: 'fail', status: 'failed', updatedAt: 60 },
    ]);
    const intent = startOrResumeMissionFromVoice(ports, {
      title: 'Voz: deploy',
    });
    expect(intent.kind).toBe('started');
    if (intent.kind === 'started') {
      expect(intent.missionId).toMatch(/^voice-/);
    }
    expect(ports.created[0]?.title).toBe('Voz: deploy');
    expect(ports.statusCalls).toEqual([
      { id: expect.stringMatching(/^voice-/), status: 'running' },
    ]);
  });

  it('starts with default title when options omit title', () => {
    const ports = makePorts([]);
    const intent = startOrResumeMissionFromVoice(ports);
    expect(intent.kind).toBe('started');
    expect(ports.created[0]?.title).toBe('Missão por voz');
  });

  it('invokes ports once per call (detection policy: one start-or-resume)', () => {
    const ports = makePorts([]);
    const listSpy = vi.spyOn(ports, 'listMissions');
    const createSpy = vi.spyOn(ports, 'createMission');
    startOrResumeMissionFromVoice(ports);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
