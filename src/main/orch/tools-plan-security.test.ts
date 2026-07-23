import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testProjectScope } from './__tests__/scope-fixture';
import { buildPlanTools } from './tools-plan';

const testRoot = path.join(os.tmpdir(), 'nexus-tools-plan-security');

describe('plan tool filesystem authority', () => {
  beforeAll(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(testRoot, 'src'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('rejects plan.md when it is a symlink to another workspace file', async () => {
    const victim = path.join(testRoot, 'src', 'victim.ts');
    const planPath = path.join(testRoot, 'plan.md');
    fs.writeFileSync(victim, 'export const untouched = true;\n');
    fs.symlinkSync(path.join('src', 'victim.ts'), planPath);
    const tool = buildPlanTools().find(
      (candidate) => candidate.name === 'nexus_plan_write',
    )!;
    const ctx = {
      role: 'worker',
      scope: testProjectScope({ rootRealPath: fs.realpathSync(testRoot) }),
    } as never;

    await expect(
      tool.handler(
        { content: '# Mission plan\n\nKeep the target file unchanged.' },
        ctx,
      ),
    ).rejects.toThrow(/symbolic link/i);
    expect(fs.readFileSync(victim, 'utf8')).toBe(
      'export const untouched = true;\n',
    );
  });
});
