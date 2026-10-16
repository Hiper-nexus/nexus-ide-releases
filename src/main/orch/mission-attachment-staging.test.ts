import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import type { SquadAgent } from '../../shared/orch-types';
import { agentPrompt } from './mission-fast-lane';
import { stageMissionAttachmentsIntoExecutionScope } from './mission-attachment-staging';

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-att-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function snapshotFor(coordRoot: string, sealedDir: string, name: string, bytes: Buffer) {
  const sealed = path.join(sealedDir, `${name}.sealed`);
  fs.writeFileSync(sealed, bytes);
  return {
    path: sealed,
    sourcePath: path.join(coordRoot, '.nexus/attachments/mission-context', name),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    sealId: 'a'.repeat(32),
    device: '1',
    inode: '2',
  };
}

function missionWith(snapshots: ReturnType<typeof snapshotFor>[]): Mission {
  return {
    id: 'm1',
    title: 'T',
    description: 'Veja o print e o áudio.',
    intentContract: {
      version: 1,
      source: 'typed',
      goal: 'g',
      acceptanceCriteria: ['a'],
      risk: 'normal',
      executionMode: 'autopilot',
      contextPolicy: 'minimal',
      intentVersion: 1,
      budgets: { planningTokens: 1, executionTokens: 1, maxWorkers: 1, maxSteps: 1 },
      workspaceBinding: { version: 1, spaceId: 'space-abc' },
      attachmentPaths: snapshots.map((s) => s.path),
      attachmentSnapshots: snapshots,
    },
  } as unknown as Mission;
}

const coordinator = {
  id: 'c',
  agentName: 'Coord',
  category: 'orchestrator',
  cli: 'claude',
} as unknown as SquadAgent;
const worker = { ...coordinator, id: 'w', category: 'executor' } as SquadAgent;

describe('anexos da missão até o prompt', () => {
  it('copia imagem e áudio (com transcrição) para a worktree e os lista no orquestrador e no worker', () => {
    const coord = tmp();
    const exec = tmp();
    const sealedDir = tmp();
    const png = Buffer.from('png-bytes');
    const wav = Buffer.from('wav-bytes');
    const image = snapshotFor(coord, sealedDir, 'print.png', png);
    const audio = snapshotFor(coord, sealedDir, 'nota.m4a', wav);
    fs.mkdirSync(path.dirname(image.sourcePath), { recursive: true });
    fs.writeFileSync(audio.sourcePath + '.transcript.txt', 'corrija o botão azul');

    stageMissionAttachmentsIntoExecutionScope({ rootRealPath: exec }, [image, audio]);

    const copied = path.join(exec, '.nexus/attachments/mission-context');
    expect(fs.readFileSync(path.join(copied, 'print.png'))).toEqual(png);
    expect(fs.readFileSync(path.join(copied, 'nota.m4a'))).toEqual(wav);

    const mission = missionWith([image, audio]);
    for (const agent of [coordinator, worker]) {
      const prompt = agentPrompt(agent, mission, ['Coord'], false, '', null, [], exec);
      expect(prompt).toContain('Anexos da missão');
      expect(prompt).toContain(`[imagem] .nexus/attachments/mission-context/print.png (absoluto: ${path.join(exec, '.nexus/attachments/mission-context/print.png')})`);
      expect(prompt).toContain('[áudio] .nexus/attachments/mission-context/nota.m4a');
      expect(prompt).toContain('Transcrição do áudio: corrija o botão azul');
    }
  });

  it('áudio sem transcrição ainda chega com o caminho e avisa', () => {
    const coord = tmp();
    const exec = tmp();
    const audio = snapshotFor(coord, tmp(), 'voz.opus', Buffer.from('x'));
    stageMissionAttachmentsIntoExecutionScope({ rootRealPath: exec }, [audio]);
    const prompt = agentPrompt(coordinator, missionWith([audio]), ['Coord'], false, '', null, [], exec);
    expect(prompt).toContain('[áudio] .nexus/attachments/mission-context/voz.opus');
    expect(prompt).toContain('Sem transcrição disponível');
  });

  it('recusa copiar bytes selados adulterados', () => {
    const coord = tmp();
    const exec = tmp();
    const image = snapshotFor(coord, tmp(), 'print.png', Buffer.from('ok'));
    fs.writeFileSync(image.path, 'adulterado');
    expect(stageMissionAttachmentsIntoExecutionScope({ rootRealPath: exec }, [image])).toEqual([]);
    expect(fs.existsSync(path.join(exec, '.nexus'))).toBe(false);
  });
});
