import { describe, expect, it } from 'vitest';
import type { ProviderQuotaEntry, QuotaWindow } from '../../shared/quota-types';
import {
  QUOTA_ENTRY_MAX_AGE_MS,
  quotaExhaustedAdapters,
  quotaPaceByAdapter,
  quotaPaceScore,
} from './quota-pace';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const win = (over: Partial<QuotaWindow>): QuotaWindow => ({
  kind: 'weekly',
  label: 'Semanal',
  usedRatio: 0.5,
  resetsAt: NOW + 3.5 * DAY,
  source: 'provider-api',
  confidence: 'high',
  ...over,
});

const entry = (
  adapterId: string,
  windows: QuotaWindow[],
  over: Partial<ProviderQuotaEntry> = {},
): ProviderQuotaEntry => ({
  id: adapterId,
  adapterId,
  label: adapterId,
  installed: true,
  onCooldown: false,
  windows,
  updatedAt: NOW,
  ...over,
});

describe('quotaPaceByAdapter', () => {
  it('desconhecido fica ausente do mapa (nunca folga nem zero)', () => {
    const pace = quotaPaceByAdapter(
      [entry('a', [win({ usedRatio: null })]), entry('b', [])],
      NOW,
    );
    expect(pace.size).toBe(0);
  });

  it('confidence low é ignorada', () => {
    const pace = quotaPaceByAdapter([entry('a', [win({ confidence: 'low', usedRatio: 0.1 })])], NOW);
    expect(pace.has('a')).toBe(false);
  });

  it('cooldown e janela cheia valem ratio 0', () => {
    const pace = quotaPaceByAdapter(
      [
        entry('cool', [win({ usedRatio: 0.1 })], { onCooldown: true }),
        entry('full', [win({ usedRatio: 1 })]),
      ],
      NOW,
    );
    expect(pace.get('cool')?.ratio).toBe(0);
    expect(pace.get('full')?.ratio).toBe(0);
  });

  it('adapter = MAX entre contas (cooldown não derruba a conta livre)', () => {
    const pace = quotaPaceByAdapter(
      [
        entry('claude', [win({ usedRatio: 0.76, resetsAt: NOW + 3.4 * DAY })], { id: 'claude:1' }),
        entry('claude', [win({ usedRatio: 0.2, resetsAt: NOW + 3.5 * DAY })], { id: 'claude:2' }),
        entry('claude', [win({ usedRatio: 0.1 })], { id: 'claude:3', onCooldown: true }),
      ],
      NOW,
    );
    expect(pace.get('claude')?.ratio).toBeCloseTo(1.6, 5);
  });

  it('conta = MIN entre janelas medidas (a que limita)', () => {
    const pace = quotaPaceByAdapter(
      [
        entry('a', [
          win({ kind: 'weekly', usedRatio: 0.1, resetsAt: NOW + 3.5 * DAY }),
          win({ kind: 'hours', label: '5 Horas', usedRatio: 0.9, resetsAt: NOW + 2.5 * 60 * 60 * 1000 }),
        ]),
      ],
      NOW,
    );
    // 5h: 0,1 de folga / 0,5 de tempo = 0,2; semanal: 0,9 / 0,5 = 1,8.
    expect(pace.get('a')).toMatchObject({ window: '5 Horas' });
    expect(pace.get('a')?.ratio).toBeCloseTo(0.2, 5);
  });

  it('janela sem reset ou de créditos não tem ritmo (tempo restante = 1)', () => {
    const pace = quotaPaceByAdapter(
      [
        entry('credits', [win({ kind: 'credits', label: 'Créditos', usedRatio: 0.4 })]),
        entry('noreset', [win({ usedRatio: 0.4, resetsAt: undefined })]),
      ],
      NOW,
    );
    expect(pace.get('credits')?.ratio).toBeCloseTo(0.6, 5);
    expect(pace.get('noreset')?.ratio).toBeCloseTo(0.6, 5);
  });

  it('exemplo real: GLM, Grok, Claude e Kimi', () => {
    const pace = quotaPaceByAdapter(
      [
        entry('glm', [win({ usedRatio: 0.096, resetsAt: NOW + 5.95 * DAY })]),
        entry('grok', [win({ usedRatio: 0.37, resetsAt: NOW + 1.75 * DAY })]),
        entry('claude', [win({ usedRatio: 0.76, resetsAt: NOW + 3.4 * DAY })]),
        entry('kimi', [win({ usedRatio: 1, resetsAt: NOW + 2 * DAY })]),
      ],
      NOW,
    );
    expect(pace.get('glm')!.ratio).toBeCloseTo(1.06, 2);
    expect(pace.get('grok')!.ratio).toBeCloseTo(2.52, 2);
    expect(pace.get('claude')!.ratio).toBeCloseTo(0.49, 2);
    expect(pace.get('kimi')!.ratio).toBe(0);
    expect(quotaPaceScore(pace.get('glm'))).toBeCloseTo(0.5, 0);
    expect(quotaPaceScore(pace.get('grok'))).toBeCloseTo(8, 0);
    expect(quotaPaceScore(pace.get('claude'))).toBeCloseTo(-6, 0);
    expect(quotaPaceScore(pace.get('kimi'))).toBe(-10);
  });

  it('tempo restante tem piso de 2% (reset iminente não explode o ratio)', () => {
    const pace = quotaPaceByAdapter([entry('a', [win({ usedRatio: 0.5, resetsAt: NOW + 1000 })])], NOW);
    expect(pace.get('a')!.ratio).toBeCloseTo(25, 5);
    expect(quotaPaceScore(pace.get('a'))).toBe(10);
  });
});

describe('quotaPaceScore', () => {
  it('ausente = 0', () => {
    expect(quotaPaceScore(undefined)).toBe(0);
  });
});

describe('janela por modelo não limita a CLI inteira (B1, F-1484)', () => {
  const general = win({ label: 'Semanal', usedRatio: 0.2, resetsAt: NOW + 3.5 * DAY });
  const scoped = (label: string) => win({ label, usedRatio: 1, resetsAt: NOW + 3.5 * DAY });

  it.each(['Semanal (Fable)', 'Semanal (Opus)', 'Semanal (Modelo X)'])(
    '%s a 100% com as gerais livres: não exclui a CLI e o ritmo é o das gerais',
    (label) => {
      const withScoped = [entry('claude', [scoped(label), general])];
      expect(quotaExhaustedAdapters(withScoped, NOW).size).toBe(0);
      const pace = quotaPaceByAdapter(withScoped, NOW).get('claude');
      expect(pace).toEqual(quotaPaceByAdapter([entry('claude', [general])], NOW).get('claude'));
      expect(pace).toMatchObject({ window: 'Semanal' });
      expect(pace!.ratio).toBeCloseTo(1.6, 5);
    },
  );

  it('só janelas escopadas: desconhecida (ausente do mapa), nunca zero nem exclusão', () => {
    const onlyScoped = [entry('claude', [scoped('Semanal (Fable)')])];
    expect(quotaPaceByAdapter(onlyScoped, NOW).has('claude')).toBe(false);
    expect(quotaExhaustedAdapters(onlyScoped, NOW).size).toBe(0);
  });

  it('o cooldown do store continua valendo mesmo sem janela geral', () => {
    const cooling = [entry('claude', [scoped('Semanal (Fable)')], { onCooldown: true })];
    expect(quotaPaceByAdapter(cooling, NOW).get('claude')?.ratio).toBe(0);
  });
});

describe('cadência da janela session (N2)', () => {
  const session = (label: string, resetsInMs: number) =>
    entry('a', [win({ kind: 'session', label, usedRatio: 0.5, resetsAt: NOW + resetsInMs })]);

  it.each(['Cota Google', 'Sessão'])(
    '%s não declara cadência: metade usada com reset em 2 h não vira folga inventada',
    (label) => {
      const pace = quotaPaceByAdapter([session(label, 2 * HOUR)], NOW).get('a')!;
      expect(pace.ratio).toBeCloseTo(0.5, 5);
      expect(quotaPaceScore(pace)).toBeLessThan(0);
    },
  );

  it('"Diário" (24 h declarado pelo provedor) continua com ritmo', () => {
    expect(quotaPaceByAdapter([session('Diário', 12 * HOUR)], NOW).get('a')!.ratio).toBeCloseTo(1, 5);
    expect(quotaPaceByAdapter([session('Diário', 2 * HOUR)], NOW).get('a')!.ratio).toBeCloseTo(6, 5);
  });
});

describe('leitura velha ou já reaberta (N4)', () => {
  const stale = { updatedAt: NOW - QUOTA_ENTRY_MAX_AGE_MS - 1 };

  it('entrada mais velha que 15 min não exclui nem dá ritmo (desconhecida)', () => {
    const entries = [entry('kimi', [win({ usedRatio: 1 })], stale)];
    expect(quotaExhaustedAdapters(entries, NOW).size).toBe(0);
    expect(quotaPaceByAdapter(entries, NOW).has('kimi')).toBe(false);
  });

  it('no limite de 15 min a leitura ainda vale; updatedAt inválido conta como velha', () => {
    const edge = [entry('kimi', [win({ usedRatio: 1 })], { updatedAt: NOW - QUOTA_ENTRY_MAX_AGE_MS })];
    expect(quotaExhaustedAdapters(edge, NOW).has('kimi')).toBe(true);
    expect(quotaPaceByAdapter(edge, NOW).get('kimi')?.ratio).toBe(0);
    const invalid = [entry('kimi', [win({ usedRatio: 1 })], { updatedAt: Number.NaN })];
    expect(quotaExhaustedAdapters(invalid, NOW).size).toBe(0);
    expect(quotaPaceByAdapter(invalid, NOW).has('kimi')).toBe(false);
  });

  it('uma conta velha é desconhecida: mantém o adapter e não derruba o ritmo da conta fresca', () => {
    const entries = [
      entry('kimi', [win({ usedRatio: 1 })], { id: 'kimi:1' }),
      entry('kimi', [win({ usedRatio: 1 })], { id: 'kimi:2', ...stale }),
      entry('glm', [win({ usedRatio: 0.2 })], { id: 'glm:1' }),
      entry('glm', [win({ usedRatio: 1 })], { id: 'glm:2', ...stale }),
    ];
    expect(quotaExhaustedAdapters(entries, NOW).size).toBe(0);
    expect(quotaPaceByAdapter(entries, NOW).get('glm')?.ratio).toBeCloseTo(1.6, 5);
  });

  it('janela cheia com reset vencido não zera o ritmo (mesma semântica da exclusão)', () => {
    const reopened = win({ kind: 'hours', label: '5 Horas', usedRatio: 1, resetsAt: NOW - 1000 });
    const mixed = [entry('claude', [reopened, win({ usedRatio: 0.2 })])];
    expect(quotaExhaustedAdapters(mixed, NOW).size).toBe(0);
    expect(quotaPaceByAdapter(mixed, NOW).get('claude')?.ratio).toBeCloseTo(1.6, 5);
    // Só a janela reaberta: nada medido que valha agora.
    expect(quotaPaceByAdapter([entry('claude', [reopened])], NOW).has('claude')).toBe(false);
  });

  it('janela cheia ainda fechada continua valendo ratio 0, com o rótulo dela', () => {
    const reopened = win({ kind: 'hours', label: '5 Horas', usedRatio: 1, resetsAt: NOW - 1000 });
    const closed = win({ kind: 'weekly', label: 'Semanal', usedRatio: 1, resetsAt: NOW + DAY });
    expect(quotaPaceByAdapter([entry('claude', [reopened, closed])], NOW).get('claude')).toMatchObject({
      ratio: 0,
      window: 'Semanal',
    });
  });
});

describe('quotaExhaustedAdapters', () => {
  const full = (id: string, over: Partial<ProviderQuotaEntry> = {}) =>
    entry('kimi', [win({ usedRatio: 1, resetsAt: NOW + DAY })], { id, ...over });

  it('exclui o adapter quando TODAS as contas têm janela medida cheia', () => {
    expect([...quotaExhaustedAdapters([full('kimi:1'), full('kimi:2')], NOW)]).toEqual(['kimi']);
  });

  it('uma conta livre ou sem leitura mantém o adapter', () => {
    expect(quotaExhaustedAdapters([full('kimi:1'), entry('kimi', [win({ usedRatio: 0.2 })], { id: 'kimi:2' })], NOW).size).toBe(0);
    expect(quotaExhaustedAdapters([full('kimi:1'), entry('kimi', [win({ usedRatio: null })], { id: 'kimi:2' })], NOW).size).toBe(0);
  });

  it('cooldown sozinho não exclui (o store decide) e janela já reaberta não conta', () => {
    expect(quotaExhaustedAdapters([entry('a', [win({ usedRatio: 0.1 })], { onCooldown: true })], NOW).size).toBe(0);
    expect(quotaExhaustedAdapters([entry('a', [win({ usedRatio: 1, resetsAt: NOW - 1000 })])], NOW).size).toBe(0);
  });
});
