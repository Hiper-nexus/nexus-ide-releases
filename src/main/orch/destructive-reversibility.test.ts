import { describe, expect, it } from 'vitest';
import { isDestructive } from '../jarvis/guardrails';
import { hasReversiblePath, planDestructiveReversibility } from './destructive-reversibility';

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

describe('substituição por lixeira só em comando simples', () => {
  it('rm sozinho vira lixeira', () => {
    const plan = planDestructiveReversibility('rm -rf build/cache');
    expect(plan.kind).toBe('trash');
  });

  it.each([
    'rm -rf build && npm install',
    'rm -rf build; npm install',
    'rm -rf build || echo falhou',
    'rm -rf $(cat alvos.txt)',
    'rm -rf build | tee log',
  ])('comando composto não vira lixeira: %s', (command) => {
    const plan = planDestructiveReversibility(command);
    expect(plan.kind).toBe('record-irreversible');
    if (plan.kind === 'record-irreversible') {
      expect(plan.reason).toMatch(/composto|lixeira/);
    }
  });

  it('backup-ref continua válido em comando composto — cria a ref e deixa rodar', () => {
    const plan = planDestructiveReversibility(
      'git reset --hard HEAD~1 && npm test',
    );
    expect(plan.kind).toBe('backup-ref');
  });
});

/**
 * Invariante de acoplagem, não teste de regex.
 *
 * A substituição por lixeira só é segura porque o `rm -rf` que roda depois vira
 * no-op de exit 0. Isso depende de `isDestructive` nunca marcar um `rm` SEM
 * `-f` — se alguém alargar aquele guardrail para `rm -r`, o preparo passaria a
 * fabricar "No such file" em cima do agente. Este teste quebra nesse dia.
 */
describe('invariante: todo rm destrutivo carrega -f', () => {
  it.each([
    'rm -rf build',
    'sudo rm -rf /tmp/x',
    'rm   -rf   node_modules',
  ])('%s', (command) => {
    expect(isDestructive(command)).toBe(true);
    expect(planDestructiveReversibility(command).kind).not.toBe(
      'not-destructive',
    );
    expect(/\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*f/.test(command)).toBe(true);
  });

  it('rm sem -f não é destrutivo hoje — logo nunca chega ao preparo', () => {
    expect(isDestructive('rm -r build')).toBe(false);
    expect(planDestructiveReversibility('rm -r build').kind).toBe(
      'not-destructive',
    );
  });
});

/**
 * O invariante que impede o pior desfecho possível desta campanha: um comando
 * SEM volta rodando SEM pergunta. É `hasReversiblePath` que o dispatch consulta
 * antes de derrubar o piso de confirmação.
 */
describe('hasReversiblePath — o piso cai só onde há desfazer', () => {
  it.each([
    'rm -rf build/cache',
    'git push --force origin main',
    'git reset --hard HEAD~1',
    'npm test',
  ])('tem caminho de volta: %s', (command) => {
    expect(hasReversiblePath(command)).toBe(true);
  });

  it.each([
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'DROP TABLE users;',
    'npm unpublish my-package',
    'rm -rf /',
    'rm -rf dist/*',
    'rm -rf build && npm install',
  ])('NÃO tem caminho de volta, logo continua perguntando: %s', (command) => {
    expect(hasReversiblePath(command)).toBe(false);
  });
});
