import { describe, expect, it } from 'vitest';
import type { ModelCatalog } from '../adapters/model-catalog';
import {
  DEFAULT_ROUTING_TABLE,
  routeTask,
  taskNeedsVision,
  type AdapterAvailability,
  type RoutingTable,
} from './task-router';

/**
 * F-1412 (operador, 12/10): "GLM 5.3 Flash com visão e mais rápido, porém
 * menos capaz, e tem o GLM 5.3, lento, porém mais capaz."
 *
 *  (a) escrita medium+ nunca rebaixa de tier por rota barata quando há opção
 *      PRONTA do próprio tier no ranking (glm-5.3, não o Flash);
 *  (b) tarefa que pede ler imagem só vai para modelo com visão — e entre eles
 *      o rápido (Flash) lidera a leitura trivial/easy/medium;
 *  (c) modelo sem visão declarada nunca recebe tarefa de imagem;
 *  (d) trivial/easy de TEXTO seguem podendo ir ao Flash.
 *
 * Espelha a evidência do catálogo vendorado (omp models-rich `input`):
 * glm-5.3 é text-only; glm-5.3-flash tem visão (palavra do operador, F-1412);
 * gpt-6-luna tem visão; kimi-code/k3 e grok-4.7 ficam SEM declaração.
 */
const VISION_CATALOG: ModelCatalog = {
  version: 1,
  adapters: {
    glm: {
      models: [
        { id: 'glm-5.3', availability: 'cheap', costTier: 'low', source: 'fixture' },
      ],
    },
    'glm-flash': {
      models: [
        { id: 'glm-5.3-flash[1m]', availability: 'cheap', costTier: 'low', source: 'fixture', vision: true },
        { id: 'glm-5.3-flash', availability: 'cheap', costTier: 'low', source: 'fixture', vision: true },
      ],
    },
    kimi: {
      models: [
        { id: 'kimi-code/k3', availability: 'paid', costTier: 'low', source: 'fixture' },
      ],
    },
    codex: {
      models: [
        { id: 'gpt-6-luna', availability: 'paid', costTier: 'low', source: 'fixture', vision: true },
      ],
    },
  },
};

const glm: AdapterAvailability = { id: 'glm', installed: true, models: ['glm-5.3'] };
const glmFlash: AdapterAvailability = {
  id: 'glm-flash',
  installed: true,
  models: ['glm-5.3-flash[1m]', 'glm-5.3-flash'],
};
const kimi: AdapterAvailability = { id: 'kimi', installed: true, models: ['kimi-code/k3'] };
const codex: AdapterAvailability = { id: 'codex', installed: true, models: ['gpt-6-luna'] };

describe('taskNeedsVision (F-1412)', () => {
  it('detecta pedido de leitura de imagem em pt e en', () => {
    expect(taskNeedsVision('analise este print .png e diga o que está escrito')).toBe(true);
    expect(taskNeedsVision('olhe esta tela e descreva o layout')).toBe(true);
    expect(taskNeedsVision('leia a imagem anexada')).toBe(true);
    expect(taskNeedsVision('veja o screenshot do erro')).toBe(true);
    expect(taskNeedsVision('descreva a foto anexada')).toBe(true);
    expect(taskNeedsVision('examine a captura de tela do painel')).toBe(true);
    expect(taskNeedsVision('look at this screenshot and describe the bug')).toBe(true);
    expect(taskNeedsVision('read the attached image erro.png')).toBe(true);
  });

  it('não vira tarefa de imagem o texto comum de código', () => {
    expect(taskNeedsVision('adicione um print no log da função')).toBe(false);
    expect(taskNeedsVision('troque a imagem do botão do banner')).toBe(false);
    expect(taskNeedsVision('corrija o alinhamento das colunas do relatório')).toBe(false);
    expect(taskNeedsVision('implementar a função de validação do formulário com testes')).toBe(false);
    expect(taskNeedsVision('listar os arquivos do diretório src')).toBe(false);
  });
});

describe('roteamento com visão (F-1412)', () => {
  it('(a) escrita medium com glm e glm-flash prontos escolhe glm-5.3, não o Flash', () => {
    // Uso do glm na missão (multi-score ligado) era o caminho real do rebaixamento:
    // o benchmark do Flash (63,4/84,3) + penalidade leve de tier batia o glm-5.3
    // com −18 de diversidade por assento e o empréstimo easy vencia o medium.
    const decision = routeTask(
      'arrumar o alinhamento das colunas do relatório de vendas no painel',
      [glm, glmFlash],
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      VISION_CATALOG,
      { missionUseCounts: new Map([['glm', 2]]), multiScore: true },
    );
    expect(decision?.adapterId).toBe('glm');
    expect(decision?.model).toBe('glm-5.3');
    expect(decision?.reason).toContain('próprio tier');
  });

  it('(a, regressão) sem histórico o medium também escolhe glm-5.3', () => {
    const decision = routeTask(
      'arrumar o alinhamento das colunas do relatório de vendas no painel',
      [glm, glmFlash],
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      VISION_CATALOG,
      { multiScore: false },
    );
    expect(decision?.adapterId).toBe('glm');
    expect(decision?.model).toBe('glm-5.3');
  });

  it('(a) o rebaixamento segue válido quando o próprio tier não tem opção pronta', () => {
    const decision = routeTask(
      'arrumar o alinhamento das colunas do relatório de vendas no painel',
      [glmFlash],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      VISION_CATALOG,
      { multiScore: false },
    );
    // hard sem nenhuma opção do próprio tier: o empréstimo do easy segue
    // legítimo ("melhor opção instalada"), é isso que mantém a rota viva.
    expect(decision?.adapterId).toBe('glm-flash');
    expect(decision?.model).toBe('glm-5.3-flash[1m]');
    expect(decision?.reason).toContain('melhor opção instalada');
  });

  it('(b) "analise este print .png" no easy vai para modelo com visão, Flash primeiro', () => {
    const decision = routeTask(
      'analise este print .png e diga o que está escrito',
      [kimi, glmFlash, codex],
      DEFAULT_ROUTING_TABLE,
      'easy',
      false,
      VISION_CATALOG,
      { multiScore: false },
    );
    expect(decision?.adapterId).toBe('glm-flash');
    expect(decision?.model).toBe('glm-5.3-flash[1m]');
    expect(decision?.reason).toContain('visão');
  });

  it('(c) modelo sem visão declarada nunca recebe tarefa de imagem', () => {
    const decision = routeTask(
      'olhe este print da tela e descreva o que você vê',
      [glm, glmFlash],
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      VISION_CATALOG,
      { multiScore: false },
    );
    // glm-5.3 é text-only no recorte vendorado: sai do pool; o Flash (visão,
    // easy) é o empréstimo legítimo — não há opção do próprio tier com visão.
    expect(decision?.adapterId).not.toBe('glm');
    expect(decision?.model).not.toBe('glm-5.3');
    expect(decision?.model).toBe('glm-5.3-flash[1m]');
    expect(decision?.reason).toContain('visão');
  });

  it('(c) degrau final (tabela sem candidato instalado) também escolhe o modelo com visão', () => {
    const onlyAbsent: RoutingTable = {
      trivial: [{ adapterId: 'claude', model: 'claude-sonnet-5-5' }],
      easy: [{ adapterId: 'claude', model: 'claude-sonnet-5-5' }],
      medium: [{ adapterId: 'claude', model: 'claude-sonnet-5-5' }],
      hard: [{ adapterId: 'claude', model: 'claude-sonnet-5-5' }],
      critical: [{ adapterId: 'claude', model: 'claude-sonnet-5-5' }],
    };
    const decision = routeTask(
      'olhe este print da tela e descreva o que você vê',
      // glm primeiro e menos usado: sem o filtro, o degrau final o escolheria.
      [glm, glmFlash],
      onlyAbsent,
      'medium',
      false,
      VISION_CATALOG,
      { multiScore: false, missionUseCounts: new Map([['glm-flash', 3]]) },
    );
    expect(decision?.reason).toContain('nenhum candidato da tabela instalado');
    expect(decision?.adapterId).toBe('glm-flash');
    expect(decision?.model).toBe('glm-5.3-flash[1m]');
  });

  it('(c) pool inteiro sem declaração de visão segue como hoje (fail-open)', () => {
    const noVisionCatalog: ModelCatalog = {
      version: 1,
      adapters: {
        glm: VISION_CATALOG.adapters!.glm!,
      },
    };
    const decision = routeTask(
      'olhe este print da tela e descreva o que você vê',
      [glm],
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      noVisionCatalog,
      { multiScore: false },
    );
    // Sem nenhum modelo declarando visão o filtro não vige: a rota segue
    // como hoje, apenas com a nota explicando a ausência de declaração.
    expect(decision?.adapterId).toBe('glm');
    expect(decision?.model).toBe('glm-5.3');
    expect(decision?.reason).toContain('nenhum modelo declara visão');
  });

  it('(d) trivial/easy de texto continuam podendo ir ao Flash', () => {
    const trivial = routeTask(
      'listar os arquivos do diretório src',
      [glmFlash],
      DEFAULT_ROUTING_TABLE,
      'trivial',
      false,
      VISION_CATALOG,
      { multiScore: false },
    );
    expect(trivial?.adapterId).toBe('glm-flash');
    const easy = routeTask(
      'corrigir typo no readme do projeto',
      [glmFlash, kimi],
      DEFAULT_ROUTING_TABLE,
      'easy',
      false,
      VISION_CATALOG,
      { multiScore: false },
    );
    // kimi lidera o easy, mas o Flash segue elegível no pool de texto.
    expect(easy?.alternatives.some((c) => c.adapterId === 'glm-flash')).toBe(true);
  });
});
