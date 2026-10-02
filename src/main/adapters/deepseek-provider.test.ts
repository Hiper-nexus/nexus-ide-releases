import { describe, expect, it } from 'vitest';
import {
  ALIBABA_TOKEN_PLAN_ANTHROPIC_BASE_URL,
  ALIBABA_TOKEN_PLAN_HOST,
  DEEPSEEK_DIRECT_HOST,
  DEEPSEEK_DIRECT_PROVIDER,
  DEEPSEEK_TOKEN_PLAN_PROVIDER,
  deepseekModelForProvider,
  deepseekModelsForProvider,
  deepseekProviderChoice,
  deepseekProviderHost,
  defaultDeepseekProviderChoice,
  httpsHostOf,
  isAlibabaPlanKey,
  isAlibabaTokenPlanUrl,
  isDeepseekProviderChoice,
} from './deepseek-provider';

describe('provedor do DeepSeek (F-724)', () => {
  it('API direta é o padrão; só o id do plano escolhe o Token Plan', () => {
    expect(deepseekProviderChoice(undefined)).toBe(DEEPSEEK_DIRECT_PROVIDER);
    expect(deepseekProviderChoice('')).toBe(DEEPSEEK_DIRECT_PROVIDER);
    expect(deepseekProviderChoice('deepseek')).toBe(DEEPSEEK_DIRECT_PROVIDER);
    // Upstreams antigos do seletor genérico (anthropic, glm…) não mudam o host.
    expect(deepseekProviderChoice('anthropic')).toBe(DEEPSEEK_DIRECT_PROVIDER);
    expect(deepseekProviderChoice('glm')).toBe(DEEPSEEK_DIRECT_PROVIDER);
    expect(deepseekProviderChoice(' deepseek-token-plan ')).toBe(
      DEEPSEEK_TOKEN_PLAN_PROVIDER,
    );
    expect(isDeepseekProviderChoice('deepseek-token-plan')).toBe(true);
    expect(isDeepseekProviderChoice('glm')).toBe(false);
  });

  it('sem escolha salva, segue o slot `deepseek` do launcher', () => {
    const plan = 'sk-sp-fixture';
    const direct = 'sk-0123456789abcdef';
    // Forma do providers.conf do operador (02/10): chave do plano amarrada à Alibaba.
    expect(defaultDeepseekProviderChoice({
      key: plan,
      baseUrl: ALIBABA_TOKEN_PLAN_ANTHROPIC_BASE_URL,
    })).toBe(DEEPSEEK_TOKEN_PLAN_PROVIDER);
    // Chave do plano sem base-url: na API direta ela só daria 401.
    expect(defaultDeepseekProviderChoice({ key: plan, baseUrl: null }))
      .toBe(DEEPSEEK_TOKEN_PLAN_PROVIDER);
    // A base-url decide quando existe, nos dois sentidos.
    expect(defaultDeepseekProviderChoice({
      key: plan,
      baseUrl: 'https://api.deepseek.com/anthropic',
    })).toBe(DEEPSEEK_DIRECT_PROVIDER);
    expect(defaultDeepseekProviderChoice({
      key: direct,
      baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com.evil.example/v1',
    })).toBe(DEEPSEEK_DIRECT_PROVIDER);
    expect(defaultDeepseekProviderChoice({ key: direct, baseUrl: null }))
      .toBe(DEEPSEEK_DIRECT_PROVIDER);
    expect(defaultDeepseekProviderChoice({ key: null, baseUrl: null }))
      .toBe(DEEPSEEK_DIRECT_PROVIDER);
  });

  it('cada provedor tem o próprio host', () => {
    expect(deepseekProviderHost(DEEPSEEK_DIRECT_PROVIDER)).toBe(DEEPSEEK_DIRECT_HOST);
    expect(deepseekProviderHost(DEEPSEEK_TOKEN_PLAN_PROVIDER)).toBe(
      ALIBABA_TOKEN_PLAN_HOST,
    );
    expect(httpsHostOf(ALIBABA_TOKEN_PLAN_ANTHROPIC_BASE_URL)).toBe(
      ALIBABA_TOKEN_PLAN_HOST,
    );
  });

  it('reconhece a chave de plano da Alibaba pelo prefixo sk-sp-', () => {
    expect(isAlibabaPlanKey('sk-sp-fixture')).toBe(true);
    expect(isAlibabaPlanKey('  sk-sp-fixture ')).toBe(true);
    expect(isAlibabaPlanKey('sk-0123456789abcdef')).toBe(false);
    expect(isAlibabaPlanKey(null)).toBe(false);
  });

  it('só aceita a URL HTTPS do Token Plan conferido, sem credencial embutida', () => {
    expect(isAlibabaTokenPlanUrl(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    )).toBe(true);
    expect(isAlibabaTokenPlanUrl('http://token-plan.ap-southeast-1.maas.aliyuncs.com/v1')).toBe(false);
    expect(isAlibabaTokenPlanUrl('https://u:p@token-plan.ap-southeast-1.maas.aliyuncs.com/v1')).toBe(false);
    expect(isAlibabaTokenPlanUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(false);
    expect(isAlibabaTokenPlanUrl('https://token-plan.ap-southeast-1.maas.aliyuncs.com.evil.example/v1')).toBe(false);
    expect(isAlibabaTokenPlanUrl('não é url')).toBe(false);
  });

  it('no plano o flash sobe como v4-pro; na API direta nada muda', () => {
    for (const flash of ['deepseek-flash', 'deepseek-v4-flash']) {
      expect(deepseekModelForProvider(flash, DEEPSEEK_TOKEN_PLAN_PROVIDER)).toBe(
        'deepseek-v4-pro',
      );
      expect(deepseekModelForProvider(flash, DEEPSEEK_DIRECT_PROVIDER)).toBe(flash);
    }
    expect(deepseekModelForProvider('deepseek-v4-pro', DEEPSEEK_TOKEN_PLAN_PROVIDER))
      .toBe('deepseek-v4-pro');
  });

  it('catálogo do plano tira os flash e garante o v4-pro', () => {
    expect(
      deepseekModelsForProvider(['deepseek-v4-pro', 'deepseek-flash'], DEEPSEEK_TOKEN_PLAN_PROVIDER),
    ).toEqual(['deepseek-v4-pro']);
    expect(
      deepseekModelsForProvider(['deepseek-flash'], DEEPSEEK_TOKEN_PLAN_PROVIDER),
    ).toEqual(['deepseek-v4-pro']);
    expect(
      deepseekModelsForProvider(['deepseek-v4-pro', 'deepseek-flash'], DEEPSEEK_DIRECT_PROVIDER),
    ).toEqual(['deepseek-v4-pro', 'deepseek-flash']);
  });
});
