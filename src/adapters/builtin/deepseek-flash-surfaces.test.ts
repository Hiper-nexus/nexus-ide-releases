import { describe, expect, it } from 'vitest';
import { adapterSchema } from '../../shared/adapter-types';
import type { Adapter, CliPtyAdapter } from '../../shared/adapter-types';
import {
  BUILTIN_MODEL_CATALOG,
  PUBLISHED_MODEL_CATALOG,
  applyModelCatalogToAdapter,
  loadModelCatalog,
} from '../../main/adapters/model-catalog';
import { resolveAdapterModelOffer } from '../../main/adapters/model-offer';
import {
  DEEPSEEK_DIRECT_HOST,
  DEEPSEEK_TOKEN_PLAN_MODEL,
  DEEPSEEK_TOKEN_PLAN_MODEL_ALIASES,
  httpsHostOf,
} from '../../main/adapters/deepseek-provider';
import { getUpstreamProvider } from '../../main/adapters/launcher-provider-manager';
import claudeAdapter from './claude.json';
import deepseekAdapter from './deepseek.json';
import qwenAdapter from './qwen.json';

const FLASH = 'deepseek-flash';

function cliPty(raw: unknown, id: string): CliPtyAdapter {
  const parsed = adapterSchema.parse(raw);
  if (parsed.kind !== 'cli-pty') throw new Error(`${id} must be cli-pty`);
  return parsed;
}

/** Catálogo em camadas como o app monta: embutido + publicado, sem USER. */
function layeredCatalog() {
  return loadModelCatalog('/nonexistent/nexus-deepseek-flash-catalog.json');
}

function catalogEntry(
  catalog: { adapters?: Record<string, { models?: readonly { id: string; availability?: string; costTier?: string }[] }> },
  adapterId: string,
) {
  return catalog.adapters?.[adapterId]?.models?.find((entry) => entry.id === FLASH);
}

describe('DeepSeek Flash no Claude, no Qwen Code e no DeepSeek', () => {
  it('entra no menu dos três adapters', () => {
    expect(claudeAdapter.models.list).toContain(FLASH);
    expect(qwenAdapter.models.list).toContain(FLASH);
    expect(deepseekAdapter.models.list).toContain(FLASH);
  });

  it('é acrescentado no fim, sem trocar o default nem o índice 0', () => {
    // A regressão do registro fixa models.list[0] no modelo mais forte.
    expect(claudeAdapter.models.list[0]).toBe('claude-opus-5-5');
    expect(claudeAdapter.models.default).toBe('claude-sonnet-5-5');
    expect(qwenAdapter.models.list[0]).toBe('qwen3.8-max');
    expect(qwenAdapter.models.default).toBe('qwen3.8-max');
    expect(claudeAdapter.models.list.at(-1)).toBe(FLASH);
    expect(qwenAdapter.models.list.at(-1)).toBe(FLASH);
  });

  it('catálogo embutido e publicado classificam o Flash como barato nas três CLIs', () => {
    for (const catalog of [BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG]) {
      for (const adapterId of ['claude', 'qwen', 'deepseek']) {
        expect(catalogEntry(catalog, adapterId)).toMatchObject({
          availability: 'cheap',
          costTier: 'free',
        });
      }
    }
  });

  it('o catálogo em camadas não cria id duplicado e mantém o default', () => {
    const catalog = layeredCatalog();
    for (const [raw, id] of [
      [claudeAdapter, 'claude'],
      [qwenAdapter, 'qwen'],
    ] as const) {
      const adapter: Adapter = applyModelCatalogToAdapter(cliPty(raw, id), catalog);
      expect(adapter.models.list.filter((model) => model === FLASH)).toHaveLength(1);
      expect(adapter.models.list).toContain(FLASH);
      expect(adapter.models.default).toBe(raw.models.default);
    }
  });

  it('a oferta e a rota automática enxergam o Flash no Claude e no Qwen', () => {
    const catalog = layeredCatalog();
    for (const [raw, id] of [
      [claudeAdapter, 'claude'],
      [qwenAdapter, 'qwen'],
    ] as const) {
      const offer = resolveAdapterModelOffer(cliPty(raw, id), { catalog });
      // As duas CLIs são `bundled`: o catálogo/manifesto é a prova do id.
      expect(offer.authority).toBe('bundled');
      expect(offer.offered).toContain(FLASH);
      expect(offer.routable).toContain(FLASH);
      expect(offer.unverified).not.toContain(FLASH);
    }
  });

  it('o endpoint que admite o Flash no Qwen Code é o mesmo da linha DeepSeek', () => {
    const route = getUpstreamProvider('deepseek');
    const staticBaseUrl = deepseekAdapter.env.static?.ANTHROPIC_BASE_URL;
    expect(httpsHostOf(route?.baseUrl)).toBe(DEEPSEEK_DIRECT_HOST);
    expect(httpsHostOf(staticBaseUrl)).toBe(DEEPSEEK_DIRECT_HOST);
    // Proxy é quem traduz o id barato: o slot haiku do adapter aponta p/ ele.
    expect(deepseekAdapter.env.static?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
      FLASH,
    );
  });

  it('no Token Plan o Flash vira o v4.1-flash-1017 servido pelo plano, nunca o id cru', () => {
    expect(DEEPSEEK_TOKEN_PLAN_MODEL_ALIASES[FLASH]).toBe(
      'deepseek-v4.1-flash-1017',
    );
    expect(DEEPSEEK_TOKEN_PLAN_MODEL).toBe('deepseek-v4-pro');
  });
});
