import { describe, expect, it } from 'vitest';
import { detectLimit } from './limit-detector';

describe('detectLimit', () => {
  it('detects Claude usage-limit messages as rate-limit', () => {
    const hit = detectLimit("Claude usage limit reached. Your limit will reset at 3pm.");
    expect(hit?.kind).toBe('rate-limit');
  });

  it('detects HTTP 429 / rate_limit', () => {
    expect(detectLimit('Error: 429 Too Many Requests')?.kind).toBe('rate-limit');
    expect(detectLimit('{"type":"rate_limit_error"}')?.kind).toBe('rate-limit');
  });

  it('detects real provider spellings without an error prefix', () => {
    // Código de erro da OpenAI (separador underscore, sem "429" junto).
    expect(detectLimit('rate_limit_exceeded')?.kind).toBe('rate-limit');
    // Classe de exceção dos SDKs (CamelCase).
    expect(detectLimit('openai.RateLimitError')?.kind).toBe('rate-limit');
  });

  it('ignores rate-limit guidance echoed from a squad prompt', () => {
    expect(
      detectLimit('RATE LIMIT: em rate limit, re-roteie para outra CLI e siga.'),
    ).toBeNull();
    expect(detectLimit('Documente como tratar rate limit no provider.')).toBeNull();
    expect(detectLimit('O exemplo de UI diz: usage limit reached')).toBeNull();
    expect(detectLimit('src/file.ts:429: const retry = true')).toBeNull();
    expect(detectLimit('mission-429 finished successfully')).toBeNull();
  });

  it('detects credit/quota exhaustion as quota (long cooldown)', () => {
    const hit = detectLimit('Your credit balance is too low to run this request.');
    expect(hit?.kind).toBe('quota');
    expect(hit!.cooldownMs).toBeGreaterThan(6 * 60 * 60 * 1000);
  });

  it('detects insufficient_quota and 402', () => {
    expect(detectLimit('insufficient_quota')?.kind).toBe('quota');
    expect(detectLimit('HTTP 402 payment required')?.kind).toBe('quota');
  });

  it('detects auth errors', () => {
    expect(detectLimit('401 authentication_error')?.kind).toBe('auth');
    expect(detectLimit('invalid api key provided')?.kind).toBe('auth');
  });

  it('detects Codex/ChatGPT and Grok limit signatures', () => {
    expect(
      detectLimit('codex: ChatGPT usage limit reached — try again later')?.kind,
    ).toBe('rate-limit');
    expect(detectLimit('Grok rate limit exceeded, try later')?.kind).toBe(
      'rate-limit',
    );
    expect(detectLimit('tokens per minute exceeded')?.kind).toBe('rate-limit');
    expect(
      detectLimit('error: session expired, please re-authenticate')?.kind,
    ).toBe('auth');
  });

  it('does not false-positive on docs or agent prose', () => {
    expect(detectLimit('Codex has no usage limit in free tier docs')).toBeNull();
    expect(detectLimit('Please log in to GitHub to continue the OAuth flow')).toBeNull();
    expect(detectLimit('server busy is a metaphor here')).toBeNull();
  });

  it('parses an explicit retry window to size the cooldown', () => {
    const hit = detectLimit('rate limit — try again in 42 minutes');
    expect(hit?.cooldownMs).toBe(42 * 60 * 1000);
  });

  it('returns null for normal output', () => {
    expect(detectLimit('Building the project... done. All tests passed.')).toBeNull();
    expect(detectLimit('Here is the code you asked for:')).toBeNull();
  });

  it('prioritises quota over generic rate-limit when both could match', () => {
    const hit = detectLimit('rate limited: insufficient_quota, out of credits');
    expect(hit?.kind).toBe('quota');
  });

  it('detects 5-hour as rate-limit and weekly as quota (long window)', () => {
    expect(detectLimit('Error: 5-hour usage limit reached')?.kind).toBe(
      'rate-limit',
    );
    const weekly = detectLimit('weekly usage limit exceeded');
    expect(weekly?.kind).toBe('quota');
    expect(weekly!.cooldownMs).toBeGreaterThan(6 * 60 * 60 * 1000);
    expect(
      detectLimit('Erro: limite de uso atingido para esta conta')?.kind,
    ).toBe('rate-limit');
    expect(detectLimit('limite de 5 horas excedido')?.kind).toBe('rate-limit');
    expect(detectLimit('cota esgotada — upgrade o plano')?.kind).toBe('quota');
    expect(detectLimit('Erro: cota esgotada nesta conta')?.kind).toBe('quota');
  });

  it('ignores bare Portuguese cota/créditos prose without error shape', () => {
    expect(
      detectLimit('Documente como tratar cota esgotada no provider.'),
    ).toBeNull();
    expect(detectLimit('O time usa créditos insuficientes como métrica.')).toBeNull();
  });
});

const HOUR = 60 * 60 * 1000;

describe('detectLimit — classificador vendorado do oh-my-pi', () => {
  it('detecta xAI "run out of credits" como quota (cooldown longo)', () => {
    const hit = detectLimit(
      'Error: 403 — you have run out of credits, please top up your account.',
    );
    expect(hit?.kind).toBe('quota');
    expect(hit!.cooldownMs).toBeGreaterThan(6 * HOUR);
  });

  it('detecta fraseologia Google/Antigravity de cota diária como quota', () => {
    // "capacity" literal NÃO pode pré-emptar o branch de quota (bug corrigido
    // no omp): "exhausted your capacity" + "quota will reset" = janela longa.
    const a = detectLimit(
      'You have exhausted your capacity on this model. Your quota will reset after 10pm PT.',
    );
    expect(a?.kind).toBe('quota');
    expect(a!.cooldownMs).toBeGreaterThan(6 * HOUR);
    const b = detectLimit('Quota will reset after midnight.');
    expect(b?.kind).toBe('quota');
  });

  it('detecta 429 opaco como rate-limit (rotaciona igual, janela 5h)', () => {
    // No omp, 429 sem corpo informativo rotaciona a conta; no Nexus todo hit
    // rotaciona via failover — o legado já classifica e mantém precedência.
    expect(detectLimit('HTTP 429')?.kind).toBe('rate-limit');
  });

  it('detecta mensagens chinesas de cota (额度不足 / 额度耗尽) como quota', () => {
    const a = detectLimit('错误: 额度不足');
    expect(a?.kind).toBe('quota');
    expect(a!.cooldownMs).toBeGreaterThan(6 * HOUR);
    expect(detectLimit('API 返回: 额度耗尽')?.kind).toBe('quota');
  });

  it('capacidade do modelo → transient com cooldown curto (45s + jitter do omp)', () => {
    const hit = detectLimit('Error: 529 — the model is over capacity right now');
    expect(hit?.kind).toBe('transient');
    expect(hit!.cooldownMs).toBeGreaterThanOrEqual(45_000);
    expect(hit!.cooldownMs).toBeLessThanOrEqual(75_000);
  });

  it('erro interno de servidor → transient com cooldown de 20s do omp', () => {
    const hit = detectLimit(
      'Anthropic API request failed: 500 Internal Server Error',
    );
    expect(hit?.kind).toBe('transient');
    expect(hit!.cooldownMs).toBe(20_000);
  });

  it('estouro por minuto fora do legado → rate-limit com 30s do omp', () => {
    // "queries per minute" não casa os padrões legados (tpm/rpm/requests);
    // o classificador do omp cobre com o cooldown transitório curto.
    const hit = detectLimit(
      'You have exceeded your 60 queries per minute. Slow down.',
    );
    expect(hit?.kind).toBe('rate-limit');
    expect(hit!.cooldownMs).toBe(30_000);
  });

  it('rate-limit de CONTA (Anthropic) é quota, não transitório', () => {
    const hit = detectLimit(
      "Your account's rate limit has been exceeded for this billing cycle.",
    );
    expect(hit?.kind).toBe('quota');
    expect(hit!.cooldownMs).toBeGreaterThan(6 * HOUR);
  });

  it('dimensiona cooldown por retry-after em texto (variantes do omp)', () => {
    // Hint que o próprio omp embute na mensagem de erro.
    const a = detectLimit('rate_limit_exceeded retry-after-ms=90000');
    expect(a?.kind).toBe('rate-limit');
    expect(a?.cooldownMs).toBe(90_000);
    // Header ecoado no terminal (curl -i / SDK verbose) — segundos.
    const b = detectLimit('HTTP 429 Too Many Requests\nretry-after: 30');
    expect(b?.cooldownMs).toBe(30_000);
    // Header de reset da janela, delta em segundos.
    const c = detectLimit('{"type":"rate_limit_error"}\nx-ratelimit-reset: 120');
    expect(c?.cooldownMs).toBe(120_000);
    // Prosa de provider com fração ("please retry in 26.3s").
    const d = detectLimit('The model is over capacity. Please retry in 26.3s.');
    expect(d?.kind).toBe('transient');
    expect(d?.cooldownMs).toBe(26_300);
  });

  it('mantém padrões do omp error-shaped (sem falso positivo em prosa)', () => {
    // Frouxidões do omp que foram apertadas para PTY: "capacity", "spending
    // limit", "per minute", "usage limit", "internal server error" nus.
    expect(detectLimit('the model has plenty of capacity for this task')).toBeNull();
    expect(detectLimit('set a monthly spending limit in the dashboard')).toBeNull();
    expect(detectLimit('free tier allows 60 requests per minute')).toBeNull();
    expect(detectLimit('a documentação fala de internal server error')).toBeNull();
    expect(detectLimit('capacity planning doc for the data team')).toBeNull();
    // Prosa de squad com "account" + "rate limit" sem verbo de resultado.
    expect(detectLimit('switch account when you see a rate limit')).toBeNull();
  });
});
