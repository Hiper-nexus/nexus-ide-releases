import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { packagedSmokeDarwinLauncher } from './smoke-packaged-app.mjs';

// F-1011: o lançador troca de imagem no mesmo pid e preserva stdio e argv.
describe.runIf(process.platform === 'darwin')('lançador disclaim do smoke empacotado', () => {
  it('executa o comando absoluto com os argumentos e a saída intactos', () => {
    const run = spawnSync(packagedSmokeDarwinLauncher(), ['/bin/echo', 'nexus', 'smoke ok'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('nexus smoke ok\n');
  });

  it('recusa comando relativo sem executar nada', () => {
    const run = spawnSync(packagedSmokeDarwinLauncher(), ['echo', 'x'], { encoding: 'utf8' });
    expect(run.status).toBe(64);
    expect(run.stdout).toBe('');
  });
});
