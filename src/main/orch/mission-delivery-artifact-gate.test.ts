import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDeliveryArtifactsForDone,
  evaluateDeliveryArtifactsForDone,
  extractObjectivePaths,
} from './mission-delivery-artifact-gate';

describe('delivery artifact gate', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-artifact-'));
    dirs.push(dir);
    return dir;
  }

  it('extrai saas-waitlist/ do objetivo', () => {
    expect(
      extractObjectivePaths('mini SaaS lista de espera em saas-waitlist/'),
    ).toContain('saas-waitlist');
  });

  it('recusa done sem arquivos no disco (waitlist vazio)', () => {
    const root = tmpRoot();
    const result = evaluateDeliveryArtifactsForDone({
      lane: 'standard',
      goal: 'mini SaaS em saas-waitlist/',
      rootRealPath: root,
      handoffs: [],
    });
    expect(result.ok).toBe(false);
    expect(() =>
      assertDeliveryArtifactsForDone({
        lane: 'standard',
        goal: 'mini SaaS em saas-waitlist/',
        rootRealPath: root,
        handoffs: [],
      }),
    ).toThrow(/não pode ficar Concluída/);
  });

  it('aceita quando a pasta do objetivo tem conteúdo', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'saas-waitlist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'saas-waitlist', 'server.js'), 'ok\n');
    expect(
      evaluateDeliveryArtifactsForDone({
        lane: 'standard',
        goal: 'mini SaaS em saas-waitlist/',
        rootRealPath: root,
        handoffs: [],
      }),
    ).toEqual({ ok: true });
  });

  it('aceita handoff success com artefatos listados', () => {
    const root = tmpRoot();
    expect(
      evaluateDeliveryArtifactsForDone({
        lane: 'standard',
        goal: 'ship something',
        rootRealPath: root,
        handoffs: [
          {
            status: 'success',
            artifacts: { files: ['hello.txt'] },
            summary: 'ok',
          },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it('plan exige plan.md no disco', () => {
    const root = tmpRoot();
    expect(
      evaluateDeliveryArtifactsForDone({
        lane: 'plan',
        goal: 'planeje',
        rootRealPath: root,
        handoffs: [],
      }).ok,
    ).toBe(false);
    fs.writeFileSync(path.join(root, 'plan.md'), '# plano\n');
    expect(
      evaluateDeliveryArtifactsForDone({
        lane: 'plan',
        goal: 'planeje',
        rootRealPath: root,
        handoffs: [],
      }),
    ).toEqual({ ok: true });
  });
});
