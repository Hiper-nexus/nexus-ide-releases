import { describe, expect, it } from 'vitest';
import { routeTask, TIER_ORDER, type AdapterAvailability, type RoutingTable } from './task-router';
import {
  billingFromAuth,
  preferSubscriptionRoute,
  subscriptionOverApiKey,
  type BillingRouteCandidate,
} from './subscription-route-preference';

const catalog = { version: 1 as const, adapters: {} };
const tableOf = (rows: RoutingTable['medium']): RoutingTable =>
  Object.fromEntries(TIER_ORDER.map((tier) => [tier, rows])) as RoutingTable;

const deepseekTable = tableOf([{ adapterId: 'deepseek', model: 'deepseek-v4-pro' }]);
const deepseek = (over: Partial<AdapterAvailability> = {}): AdapterAvailability => ({
  id: 'deepseek', installed: true, billing: 'api-key',
  models: ['deepseek-v4-pro', 'deepseek-flash'], ...over,
});
const qwen = (over: Partial<AdapterAvailability> = {}): AdapterAvailability => ({
  id: 'qwen', installed: true, billing: 'subscription',
  models: ['qwen3.8-max', 'deepseek-flash'], ...over,
});

describe('preferSubscriptionRoute (pura)', () => {
  const c = (adapterId: string, over: Partial<BillingRouteCandidate> = {}): BillingRouteCandidate =>
    ({ adapterId, billing: 'api-key', ready: true, healthy: true, ...over });

  it('põe assinatura pronta e saudável antes da API key, mantendo a ordem do resto', () => {
    const out = preferSubscriptionRoute([
      c('paid-a'), c('sub-cooling', { billing: 'subscription', ready: false }),
      c('sub-ok', { billing: 'subscription' }), c('paid-b'),
    ]);
    expect(out.map((x) => x.adapterId)).toEqual(['sub-ok', 'paid-a', 'sub-cooling', 'paid-b']);
  });

  it('assinatura com circuito aberto ou cobrança desconhecida não sobe', () => {
    const out = preferSubscriptionRoute([
      c('paid'), c('sub-open', { billing: 'subscription', healthy: false }), c('unknown', { billing: undefined }),
    ]);
    expect(out.map((x) => x.adapterId)).toEqual(['paid', 'sub-open', 'unknown']);
  });

  it('subscriptionOverApiKey só troca API key explícita por assinatura pronta', () => {
    const paid = c('paid');
    const sub = c('sub', { billing: 'subscription' });
    expect(subscriptionOverApiKey(paid, [sub])?.pick).toBe(sub);
    expect(subscriptionOverApiKey(paid, [sub])?.note).toBe('; preferiu assinatura (sub) à API key (paid)');
    expect(subscriptionOverApiKey(paid, [{ ...sub, ready: false }])).toBeNull();
    expect(subscriptionOverApiKey(c('unknown', { billing: undefined }), [sub])).toBeNull();
    expect(subscriptionOverApiKey(sub, [paid])).toBeNull();
  });

  it('billingFromAuth mapeia a estratégia de auth', () => {
    expect(billingFromAuth({ authStrategy: 'subscription' })).toBe('subscription');
    expect(billingFromAuth({ authStrategy: 'api-key' })).toBe('api-key');
    expect(billingFromAuth({ authStrategy: 'api-key', flatRatePlan: true })).toBe('subscription');
    expect(billingFromAuth({ authStrategy: 'login-needed' })).toBeUndefined();
  });
});

describe('roteador: assinatura antes da API key para o mesmo modelo', () => {
  it('DeepSeek com Qwen Code autenticado escolhe qwen com modelo deepseek', () => {
    const decision = routeTask('implementar componente', [deepseek(), qwen()],
      deepseekTable, 'medium', false, catalog);
    expect(decision).toMatchObject({ adapterId: 'qwen', model: 'deepseek-flash' });
    expect(decision?.reason).toContain('preferiu assinatura (qwen) à API key (deepseek)');
    expect(decision?.alternatives.some((alt) => alt.adapterId === 'deepseek')).toBe(true);
  });

  it('Qwen sem credencial ou em cooldown (fora do pool) cai no deepseek por API key', () => {
    const decision = routeTask('implementar componente', [
      deepseek(), qwen({ installed: false, unavailableReason: 'todas as contas em cooldown' }),
    ], deepseekTable, 'medium', false, catalog);
    expect(decision).toMatchObject({ adapterId: 'deepseek', model: 'deepseek-v4-pro' });
    expect(decision?.reason).not.toContain('preferiu assinatura');
  });

  it('Qwen que não serve nenhum modelo da família não é escolhido', () => {
    const decision = routeTask('implementar componente', [deepseek(), qwen({ models: ['qwen3.8-max'] })],
      deepseekTable, 'medium', false, catalog);
    expect(decision?.adapterId).toBe('deepseek');
  });

  it('pin do operador no texto (modelo) é respeitado', () => {
    const decision = routeTask('implementar componente com deepseek-v4-pro', [deepseek(), qwen()],
      deepseekTable, 'medium', false, catalog);
    expect(decision?.adapterId).toBe('deepseek');
    expect(decision?.reason).not.toContain('preferiu assinatura');
  });

  it('CLI pedida em preferAdapters é respeitada', () => {
    const decision = routeTask('implementar componente', [deepseek(), qwen()],
      deepseekTable, 'medium', false, catalog, { preferAdapters: ['deepseek'] });
    expect(decision?.adapterId).toBe('deepseek');
    expect(decision?.reason).not.toContain('preferiu assinatura');
  });

  it('regra genérica com dois adapters fictícios', () => {
    const table = tableOf([{ adapterId: 'paid-cli', model: 'acme-pro' }]);
    const paid: AdapterAvailability = {
      id: 'paid-cli', installed: true, billing: 'api-key', models: ['acme-pro'],
      modelFamilies: { 'acme-pro': 'acme' },
    };
    const plan: AdapterAvailability = {
      id: 'plan-cli', installed: true, billing: 'subscription', models: ['acme-lite'],
      modelFamilies: { 'acme-lite': 'acme' },
    };
    const decision = routeTask('tarefa', [paid, plan], table, 'medium', false, catalog);
    expect(decision).toMatchObject({ adapterId: 'plan-cli', model: 'acme-lite' });
    expect(decision?.reason).toContain('preferiu assinatura (plan-cli) à API key (paid-cli)');
    const without = routeTask('tarefa', [paid, { ...plan, installed: false }], table, 'medium', false, catalog);
    expect(without?.adapterId).toBe('paid-cli');
  });
});
