import { describe, expect, it } from 'vitest';
import { describeCronReversal } from './cron-reversibility';

const JOB = {
  id: 'cron-7',
  name: 'varredura noturna',
  schedule: '0 3 * * *',
  status: 'active',
};

describe('frase de desfazer de agenda', () => {
  /**
   * O id é o teste inteiro: sem ele a mensagem é simpática e inútil. Uma agenda
   * criada por uma missão dispara semanas depois, e "uma agenda mudou" não é
   * desfazível por ninguém.
   */
  it('criação nomeia o risco (sobrevive à missão) e o comando de desfazer', () => {
    const texto = describeCronReversal({ action: 'create', created: JOB });

    expect(texto).toContain('cron-7');
    expect(texto).toContain('depois desta missão');
    expect(texto).toContain('nexus_cron delete');
  });

  it('alteração cita o valor ANTERIOR do campo que mudou, não o novo', () => {
    const texto = describeCronReversal({
      action: 'update',
      before: JOB,
      after: { ...JOB, schedule: '*/5 * * * *' },
    });

    expect(texto).toContain('horário "0 3 * * *"');
    expect(texto).not.toContain('nome "');
    expect(texto).toContain('id=cron-7');
  });

  it('alteração sem campo observável ainda entrega um caminho de volta', () => {
    const texto = describeCronReversal({
      action: 'update',
      before: JOB,
      after: { ...JOB, id: JOB.id },
    });

    expect(texto).toContain('os campos anteriores');
  });

  it('remoção carrega o suficiente para recriar a agenda', () => {
    const texto = describeCronReversal({ action: 'delete', before: JOB });

    expect(texto).toContain('varredura noturna');
    expect(texto).toContain('0 3 * * *');
    expect(texto).toContain('nexus_cron create');
  });
});
