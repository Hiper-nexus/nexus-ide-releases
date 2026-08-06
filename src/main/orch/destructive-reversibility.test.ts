import { describe, expect, it } from 'vitest';
import { planDestructiveReversibility } from './destructive-reversibility';

/**
 * Zero fricção com honestidade (0.27.1): nenhuma pergunta antes de agir, mas
 * NADA some sem caminho de volta escrito.
 */
describe('planDestructiveReversibility', () => {
  it('manda rm -rf de caminho comum para a LIXEIRA', () => {
    const plano = planDestructiveReversibility('rm -rf build/cache');
    expect(plano.kind).toBe('trash');
    expect(plano.kind === 'trash' && plano.paths).toEqual(['build/cache']);
  });

  it('captura vários caminhos de um rm -rf', () => {
    const plano = planDestructiveReversibility('rm -rf dist build .cache');
    expect(plano.kind === 'trash' && plano.paths).toEqual(['dist', 'build', '.cache']);
  });

  it('push --force guarda ref de backup do tip anterior', () => {
    const plano = planDestructiveReversibility('git push --force origin main');
    expect(plano.kind).toBe('backup-ref');
    expect(plano.kind === 'backup-ref' && plano.subject).toBe('remote-tip');
  });

  it('reset --hard guarda o HEAD anterior', () => {
    const plano = planDestructiveReversibility('git reset --hard HEAD~3');
    expect(plano.kind).toBe('backup-ref');
    expect(plano.kind === 'backup-ref' && plano.subject).toBe('head');
  });

  it('rm -rf em raiz/home/volume NÃO vai pra lixeira — registra', () => {
    for (const cmd of ['rm -rf /', 'rm -rf /Volumes/Backup', 'rm -rf ~']) {
      expect(planDestructiveReversibility(cmd).kind).toBe('record-irreversible');
    }
  });

  it('o que não tem desfazer é declarado irreversível, nunca perguntado', () => {
    for (const cmd of [
      'mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda',
      'npm unpublish my-pkg',
      'DROP TABLE users',
    ]) {
      const plano = planDestructiveReversibility(cmd);
      expect(plano.kind).toBe('record-irreversible');
      expect(plano.kind === 'record-irreversible' && plano.reason).toBeTruthy();
    }
  });

  it('comando comum não é destrutivo', () => {
    expect(planDestructiveReversibility('npm test').kind).toBe('not-destructive');
    expect(planDestructiveReversibility('git status').kind).toBe('not-destructive');
  });

  it('todo plano nomeia o comando, para a auditoria não ser vaga', () => {
    expect(planDestructiveReversibility('rm -rf tmp').command).toBe('rm -rf tmp');
  });
});
