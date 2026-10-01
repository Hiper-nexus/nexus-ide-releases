import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { testProjectScope } from './__tests__/scope-fixture';
import { resolveCwdForScope } from './workspace-path';

const tempDirs: string[] = [];
function tempProject(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'nexus-ws-')));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('resolveCwdForScope', () => {
  it('F-241: cwd fora do workspace mantém o prefixo e diz a saída', () => {
    const root = tempProject();
    const outside = tempProject();

    let message = '';
    try {
      resolveCwdForScope(testProjectScope({ rootRealPath: root }), outside);
    } catch (error) {
      message = (error as Error).message;
    }

    // O prefixo é o contrato que chamadores e testes casam (spawn-authority,
    // cron-runtime-workspace, tools-browser-workspace).
    expect(message).toContain(`cwd escapes workspace: ${outside}`);
    expect(message).toContain(root);
    expect(message).toContain('isolatedWriter:true');
  });

  it('cwd dentro do workspace continua resolvendo para o caminho real', () => {
    const root = tempProject();
    expect(
      resolveCwdForScope(testProjectScope({ rootRealPath: root }), '.'),
    ).toBe(root);
  });
});
