import { describe, expect, it } from 'vitest';
import {
  CONTEXT_HANDOFF_BUDGET_ERROR,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_HANDOFF_TOKEN_CAP,
  MIN_HANDOFF_RESERVE_TOKENS,
  handoffBudget,
  handoffWindow,
  historyCost,
  prepareContextHandoff,
  selectHistory,
  terminalHistoryItems,
  type HandoffHistoricalMessage,
} from './context-handoff-budget';
import { detectLimit, quotedLimitSignalPatterns } from './limit-detector';

function terminal(index: number, text: string): HandoffHistoricalMessage {
  return { role: 'assistant', kind: 'terminal_output', itemId: `terminal-${index}`, text };
}

const request: HandoffHistoricalMessage = {
  role: 'user',
  kind: 'original_request',
  itemId: 'request',
  text: 'Portar o orçamento de contexto do T3 Code para o failover.',
};

describe('ORC-05 handoffWindow / handoffBudget', () => {
  it('sem telemetria assume janela de 128.000 e reserva ≥16.000 (1/4 quando maior)', () => {
    expect(handoffWindow({})).toEqual({ window: DEFAULT_CONTEXT_WINDOW_TOKENS, reserve: 32_000 });
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(128_000);
    // Janela pequena conhecida: vale o piso de 16.000.
    expect(handoffWindow({ contextUsage: { maxTokens: 40_000 } })).toEqual({
      window: 40_000,
      reserve: MIN_HANDOFF_RESERVE_TOKENS,
    });
    expect(MIN_HANDOFF_RESERVE_TOKENS).toBe(16_000);
    // 128.000 − pedido (85.000 + aspas JSON) − reserva de 32.000.
    expect(handoffBudget({ currentRequest: 'x'.repeat(85_000) })).toBe(128_000 - 85_002 - 32_000);
    // Telemetria de uso e janela menor restringem; maxTokens inválido é ignorado.
    expect(handoffBudget({
      currentRequest: 'x'.repeat(10_000),
      contextUsage: { usedTokens: 5_000, maxTokens: 40_000 },
    })).toBe(40_000 - 5_000 - 10_002 - 16_000);
    expect(handoffBudget({
      currentRequest: 'x'.repeat(85_000),
      contextUsage: { maxTokens: 0 },
    })).toBe(128_000 - 85_002 - 32_000);
  });

  it('teto de 16.000 tokens: pedido curto nunca libera mais que o teto', () => {
    expect(DEFAULT_HANDOFF_TOKEN_CAP).toBe(16_000);
    expect(handoffBudget({ currentRequest: 'continuar' })).toBe(16_000);
    expect(handoffBudget({ currentRequest: 'continuar', modelContextWindow: 1_000_000 })).toBe(16_000);
    const messages = Array.from({ length: 40 }, (_, i) => terminal(i + 1, `linha ${i + 1} `.repeat(120)));
    const result = prepareContextHandoff({ currentRequest: 'continuar', messages: [request, ...messages], coverage: 'ponteiros' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.budget).toBe(16_000);
    expect(Buffer.byteLength(JSON.stringify(result.context)) + 256).toBeLessThanOrEqual(16_000);
    expect(result.omittedItems).toBeGreaterThan(0);
    // Ponteiro auditável: contagem e ids omitidos, itens inteiros.
    expect(result.context).toContain(`omitted ${result.omittedItems} items`);
    expect(result.omittedItemIds).toContain('terminal-1');
  });
});

describe('ORC-05 selectHistory', () => {
  it('prioriza pedido original e saída mais recente; item grande sai inteiro, nunca cortado', () => {
    const huge = terminal(2, 'y'.repeat(20_000));
    const messages = [request, terminal(1, 'antigo'), huge, terminal(3, 'mais recente')];
    const selected = selectHistory({ messages, coverage: 'ponteiros', budget: 4_000 });
    expect(selected.messages.map((m) => m.itemId)).toEqual(['request', 'terminal-1', 'terminal-3']);
    expect(selected.omittedItemIds).toEqual(['terminal-2']);
    expect(historyCost(selected.messages, selected.context)).toBeLessThanOrEqual(4_000);
    // Itens selecionados mantêm o texto completo.
    expect(selected.messages.find((m) => m.itemId === 'request')?.text).toBe(request.text);
  });
});

describe('ORC-05 prepareContextHandoff', () => {
  it('estouro devolve erro em vez de cortar o pedido corrente', () => {
    const currentRequest = 'pedido '.repeat(15_000);
    const result = prepareContextHandoff({ currentRequest, messages: [request], coverage: 'ponteiros' });
    expect(result).toMatchObject({ ok: false, error: CONTEXT_HANDOFF_BUDGET_ERROR, budget: 0 });
    if (result.ok) return;
    expect(result.message).toContain('o pedido corrente não foi encurtado');
  });

  it('ponteiros detalhados que lotariam o orçamento viram o ponteiro compacto', () => {
    const result = prepareContextHandoff({
      currentRequest: 'continuar',
      messages: [request],
      coverage: `ponteiro detalhado ${'z'.repeat(9_000)}`,
      compactCoverage: 'ponteiro compacto',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context).toContain('ponteiro compacto');
    expect(result.context).not.toContain('ponteiro detalhado');
  });

  it('redige segredos e mascara citações de limite antes de pôr histórico no prompt', () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX';
    const result = prepareContextHandoff({
      currentRequest: 'continuar',
      messages: [
        { ...request, text: `use a chave ${secret} e Authorization: Bearer abcdefghijklmnop123456` },
        terminal(1, 'API Error: 429 rate limit exceeded\nusage limit reached'),
      ],
      coverage: 'ponteiros GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context).not.toContain(secret);
    expect(result.context).not.toContain('abcdefghijklmnop123456');
    expect(result.context).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(result.context).toContain('[REDACTED]');
    // F-249/F-511: texto citado nunca prova limite.
    expect(detectLimit(result.context)).toBeNull();
  });
});

describe('ORC-05 terminalHistoryItems', () => {
  it('redige a cauda inteira antes de fragmentar: nenhum item leva pedaço de segredo', () => {
    const pemBody = Array.from({ length: 40 }, () => `${'P3m'.repeat(21)}Q`);
    const items = terminalHistoryItems([
      `${'a'.repeat(1_984)} sk-ant-api03-${'K7'.repeat(15)} fim`,
      `${'b'.repeat(1_983)} ghp_${'G5'.repeat(14)} fim`,
      `${'c'.repeat(1_977)} Authorization: Bearer ${'B9'.repeat(16)} fim`,
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      ...pemBody,
      '-----END OPENSSH PRIVATE KEY-----',
      'depois da chave',
    ].join('\n'));
    expect(items.length).toBeGreaterThan(3);
    for (const item of items) {
      expect(item.text.length).toBeLessThanOrEqual(2_000);
      for (const fragment of ['K7K7', 'G5G5', 'B9B9', 'P3mP3m']) expect(item.text).not.toContain(fragment);
    }
    expect(items.at(-1)?.text).toContain('depois da chave');
  });

  it('neutraliza todo formato do detector antes de selecionar', () => {
    const items = terminalHistoryItems('Error: model_not_found\nid=xmodel_not_found;\n> HTTP 401\nusage_limit_reached');
    const text = items.map((item) => item.text).join('\n');
    for (let start = 0; start < text.length; start += 1) {
      for (const end of [start + 1, start + 8, start + 20, text.length]) {
        expect(detectLimit(text.slice(start, end)), text.slice(start, end)).toBeNull();
      }
    }
  });
});

describe('ORC-05 quotedLimitSignalPatterns (anti-drift)', () => {
  it('cobre o detector inteiro em versão permissiva: sem âncora, fronteira nem lookaround', () => {
    const patterns = quotedLimitSignalPatterns();
    expect(patterns.length).toBeGreaterThan(60);
    for (const re of patterns) {
      expect(re.flags).toContain('g');
      expect(re.source).not.toMatch(/\\b|\(\?<?[=!]|(?<!\[)\^|(?<!\\)\$/);
    }
  });
});
