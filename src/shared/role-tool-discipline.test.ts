import { describe, expect, it } from 'vitest';
import { disallowedToolsForRole } from './role-tool-discipline';

/**
 * Disciplina de papel como CONFIG DE LAUNCH, não como pedido no prompt.
 *
 * Medido no Overclock: o piloto dele não tem Read/Bash/pane_list porque essas
 * tools são REMOVIDAS no spawn via argv `--disallowedTools` — não porque um
 * prompt pede bom comportamento. É por isso que o orquestrador dele não deriva
 * para fazer o trabalho sozinho: a capacidade está AUSENTE, não desencorajada.
 *
 * É o irmão natural do nosso allowedSkills por pane, um nível abaixo: garantia
 * estrutural em vez de instrucional, mesma família do hook fail-closed.
 */
describe('disallowedToolsForRole', () => {
  it('orquestrador não recebe ferramenta de execução', () => {
    const negadas = disallowedToolsForRole('orchestrator');
    expect(negadas).toContain('Bash');
    expect(negadas).toContain('Edit');
    expect(negadas).toContain('Write');
  });

  it('revisor read-only não recebe ferramenta de escrita', () => {
    const negadas = disallowedToolsForRole('reviewer');
    expect(negadas).toContain('Edit');
    expect(negadas).toContain('Write');
    // Mas LÊ: revisar sem ler é impossível.
    expect(negadas).not.toContain('Read');
    expect(negadas).not.toContain('Grep');
  });

  it('executor recebe tudo — é quem faz o trabalho', () => {
    expect(disallowedToolsForRole('executor')).toEqual([]);
  });

  it('papel desconhecido não restringe nada (fail-open de CAPACIDADE)', () => {
    // Restringir por engano quebraria trabalho legítimo; a autoridade real
    // continua no gate síncrono do pretool.
    expect(disallowedToolsForRole('desconhecido')).toEqual([]);
  });

  it('a lista é estável e ordenada, para o argv ser determinístico', () => {
    const a = disallowedToolsForRole('orchestrator');
    const b = disallowedToolsForRole('orchestrator');
    expect(a).toEqual(b);
    expect([...a]).toEqual([...a].sort());
  });
});
