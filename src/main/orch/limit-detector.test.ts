import { describe, expect, it } from 'vitest';
import { detectLimit, tierScopeFromModelId } from './limit-detector';
import { sanitizeHandoffExcerptForDetector } from '../../shared/failover-handoff';

describe('detectLimit', () => {
  it.each([
    'Corrija o internal_error que aparece no nosso aplicativo iOS.',
    'A missão investiga internal-server-error na tela do cliente.',
    'Failure|rate-limit',
    'Failure | rate_limit',
    'O aviso mostra Failure|rate-limit, mas o provider está funcionando.',
  ])('does not use prompt prose or a status-table label as a provider error: %s', (text) => {
    expect(detectLimit(text)).toBeNull();
  });

  it.each([
    'internal_error',
    'Error: internal_error: request failed',
    'API Error: {"error":{"type":"internal_error","message":"retry later"}}',
    '{"error":{"type":"internal_error","message":"retry later"}}',
  ])('still recognizes an actual internal-error response: %s', (text) => {
    expect(detectLimit(text)?.kind).toBe('transient');
  });
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

  it('detecta modelo rejeitado como kind model (conta sadia, rotação de modelo)', () => {
    // Texto real do Codex CLI desatualizada (2026-09-14): erro 400 na abertura
    // do pane — a conta está operacional, só o modelo não é suportado.
    expect(
      detectLimit(
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}',
      )?.kind,
    ).toBe('model');
    // Canônicos reais por provider:
    expect(
      detectLimit(
        "Error: The model 'gpt-5.7' does not exist or you do not have access to it.",
      )?.kind,
    ).toBe('model');
    expect(detectLimit('not_found_error: model: claude-opus-9 not found')?.kind).toBe('model');
    expect(detectLimit('API error: models/gemini-3.9-pro is not found for API version v1')?.kind).toBe(
      'model',
    );
    expect(detectLimit('{"code": "model_not_found"}')?.kind).toBe('model');
    // F-683: OpenCode Zen com o modelo desligado para a conta (campo 29/09).
    expect(detectLimit('Error: Upstream request failed: Model access is disabled')?.kind).toBe('model');
    expect(detectLimit('O acesso ao modelo está desligado? vou checar depois.')).toBeNull();
    // Prosa de agente citando o erro NUNCA dispara — disparar aqui mata
    // sessão sadia e reescreve o modelo do pane (doutrina error-shaped).
    expect(detectLimit('If the API returns model not found, upgrade the CLI.')).toBeNull();
    expect(detectLimit('Deu model not found quando tentei o gemini-3.9-pro.')).toBeNull();
    expect(detectLimit('Vamos migrar o modelo do squad para o gemini-3.8.')).toBeNull();
    expect(detectLimit('O modelo requer uma versão mais nova? melhor atualizar.')).toBeNull();
  });

  it('ignora erros citados em blockquotes Markdown (EN/PT)', () => {
    expect(
      detectLimit(
        [
          '> Provider response:',
          '> Error: HTTP 429 Too Many Requests',
          '> status code: 401',
        ].join('\n'),
      ),
    ).toBeNull();
    expect(
      detectLimit(
        [
          '  > Trecho histórico:',
          '  > Erro: cota esgotada nesta conta',
          '  >> Erro: sessão expirada',
        ].join('\n'),
      ),
    ).toBeNull();
  });

  it('ignora erros dentro de code fences Markdown completos ou em streaming', () => {
    expect(
      detectLimit(
        [
          'Exemplo da documentação:',
          '```text',
          'Error: HTTP 429 Too Many Requests',
          'rate_limit_exceeded',
          'invalid api key provided',
          '```',
        ].join('\n'),
      ),
    ).toBeNull();
    expect(
      detectLimit(
        [
          'Exemplo sem language tag:',
          '```',
          'Error: HTTP 429 Too Many Requests',
          '```',
        ].join('\n'),
      ),
    ).toBeNull();
    expect(
      detectLimit(
        [
          'Saída histórica:',
          '~~~log',
          'Erro: limite de uso atingido para esta conta',
          'HTTP 401 Unauthorized',
          '~~~',
        ].join('\n'),
      ),
    ).toBeNull();
    expect(
      detectLimit(
        [
          'O agente ainda está escrevendo o bloco:',
          '```console',
          'HTTP 402 payment required',
        ].join('\n'),
      ),
    ).toBeNull();
  });

  it('não usa fence órfão para mascarar um erro real posterior', () => {
    expect(
      detectLimit(
        [
          'Trecho anterior saiu da janela rolante.',
          '```',
          'Error: HTTP 429 Too Many Requests',
        ].join('\n'),
      )?.kind,
    ).toBe('rate-limit');
  });

  it('ignora exemplos em inline code e linhas rotuladas como log/output', () => {
    expect(
      detectLimit('A documentação usa `rate_limit_exceeded` como exemplo.'),
    ).toBeNull();
    expect(
      detectLimit('Log output: Error: HTTP 429 Too Many Requests'),
    ).toBeNull();
    expect(
      detectLimit('Saída do log: Erro: sessão expirada'),
    ).toBeNull();
    expect(detectLimit('stdout: invalid api key provided')).toBeNull();
    expect(detectLimit('stderr: HTTP 402 payment required')).toBeNull();
  });

  it('não mascara sinal real misturado com conteúdo citado', () => {
    const rateLimit = detectLimit(
      [
        '> Histórico: Error: HTTP 401 Unauthorized',
        '```log',
        'HTTP 402 payment required',
        '```',
        'Provider request failed.',
        'Error: HTTP 429 Too Many Requests',
      ].join('\n'),
    );
    expect(rateLimit?.kind).toBe('rate-limit');
    expect(rateLimit?.reason).toMatch(/429|too many requests/i);

    const auth = detectLimit(
      'A documentação usa `rate_limit_exceeded`; Error: HTTP 401 Unauthorized',
    );
    expect(auth?.kind).toBe('auth');
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

  // REGRESSAO: prova de campo com os quatro textos reais de esgotamento — este
  // era o UNICO nao reconhecido. A frase da OpenAI inverte a ordem ("exceeded
  // your current quota") e o padrao existente so casava "quota exceeded", entao
  // a mensagem humana sem o codigo ao lado nunca virava troca de conta.
  it('reconhece a frase de cota da OpenAI na ordem em que ela e escrita', () => {
    expect(
      detectLimit(
        'You exceeded your current quota, please check your plan and billing details.',
      )?.kind,
    ).toBe('quota');
    expect(detectLimit('exceeded your monthly quota')?.kind).toBe('quota');
    // Prosa de agente NAO pode virar limite: sem "exceeded ... quota" junto.
    expect(detectLimit('o time exceeded expectations neste sprint')).toBeNull();
  });

  it('detects auth errors', () => {
    expect(detectLimit('401 authentication_error')?.kind).toBe('auth');
    expect(detectLimit('invalid api key provided')?.kind).toBe('auth');
    expect(
      detectLimit(
        'Error: [internal] Stored token for "kimi-code" was rejected; re-login required.',
      )?.kind,
    ).toBe('auth');
  });

  it('does not treat Claude CLI client retry ticker as provider retry-after', () => {
    // Campo: 401 + "Retrying in 1s · attempt 1/10" no mesmo buffer virava
    // cooldown de 1s → "Sessão recuperada" → 401 de novo → continuidade no /login.
    const hit = detectLimit(
      [
        '● Please run /login · API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
        '● API error · Retrying in 1s · attempt 1/10',
      ].join('\n'),
    );
    expect(hit?.kind).toBe('auth');
    expect(hit?.cooldownMs).toBe(15 * 60 * 1000);
  });

  it('still honours a real rate-limit window when a client ticker is also present', () => {
    const hit = detectLimit(
      'Error: 429 Too Many Requests — try again in 42 minutes. Retrying in 1s · attempt 1/10',
    );
    expect(hit?.kind).toBe('rate-limit');
    expect(hit?.cooldownMs).toBe(42 * 60 * 1000);
  });

  it('detects real 401 spellings (framed number / unauthorized)', () => {
    expect(detectLimit('Error: HTTP 401 Unauthorized')?.kind).toBe('auth');
    expect(detectLimit('API request failed: 401 Unauthorized')?.kind).toBe('auth');
    expect(detectLimit('status code: 401')?.kind).toBe('auth');
    expect(detectLimit('error: 401')?.kind).toBe('auth');
  });

  it('does NOT treat the failover handoff pack as a fresh limit (phantom loop)', () => {
    // The failover continuity pack is injected into the SAME pane's PTY and
    // echoed back onto stdout, where the detector re-scans it. A bare "401" in
    // that self-authored text must NOT re-trigger failover — that was the
    // "Limite atingido em <conta>" loop on the last remaining account.
    expect(
      detectLimit(
        '[NEXUS FAILOVER HANDOFF]\n' +
          'Account "conta b" hit a provider limit (401 — retry automático (conta liberada)).\n' +
          'You are now running on account "conta adm" in a NEW provider session.',
      ),
    ).toBeNull();
    // Agent prose that merely mentions a 401/402 while working must not fire.
    expect(
      detectLimit('the failover engine fires whenever it sees a 401 in the output'),
    ).toBeNull();
    expect(detectLimit('see issue #402 for the payment refactor')).toBeNull();
    expect(detectLimit('the log rotated at line 401 of the trace')).toBeNull();
  });

  it('ignores a full handoff pack whose scrollback echoes a FRAMED provider error', () => {
    // The real cascade: the continuity pack embeds a scrollback excerpt of the
    // PRIOR terminal, which quotes the ORIGINAL provider error verbatim. Framing
    // the bare number does not help — "HTTP 401", "payment required", "429" all
    // survive framing. The whole self-authored pack (header → footer, excerpt
    // included) must be excised before matching, or every replacement account
    // is cooled down in turn (the fleet-wide phantom cascade).
    const pack = [
      '[NEXUS FAILOVER HANDOFF]',
      'Account "conta adm" hit a provider limit (HTTP 401 Unauthorized).',
      'You are now running on account "conta b" in a NEW provider session.',
      'Terminal scrollback above is historical context only — the previous conversation id is NOT transferable across accounts.',
      'Continue as the orchestrator from the next pending step. Do not re-do completed work.',
      'Mission id: mission-7ab5d15d.',
      'Recent terminal excerpt (may be partial):',
      '"""',
      'Error: HTTP 401 Unauthorized. status code: 429 too many requests. payment required. rate_limit_exceeded.',
      '"""',
      'Execute the next concrete step now.',
    ].join('\n');
    expect(detectLimit(pack)).toBeNull();
  });

  it('still detects a real limit that arrives AFTER the handoff pack', () => {
    // Isolation is scoped to Nexus's own pack — real provider output that lands
    // in the same buffer, after the pack footer, must still fire failover.
    const s =
      '[NEXUS FAILOVER HANDOFF]\n' +
      'Account "conta adm" hit a provider limit (HTTP 401 Unauthorized).\n' +
      'Execute the next concrete step now.\n' +
      '\n$ codex run\nError: 429 Too Many Requests';
    expect(detectLimit(s)?.kind).toBe('rate-limit');
  });

  it('ignores a legacy handoff reason redrawn without its header', () => {
    const historical = '  Account "Conta Claude" hit a provider limit (status: 401).';
    expect(detectLimit(`${historical}\nContinuando a tarefa.`)).toBeNull();
    expect(detectLimit(`${historical}\nAPI Error: 401 Unauthorized`)?.kind).toBe('auth');
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

  it('trata o payload literal overloaded_error da Anthropic como transitório curto', () => {
    const hit = detectLimit(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    );
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

  it('"status:503" do provider é transient, nunca limite de conta (ping-pong 23/09)', () => {
    for (const text of [
      'API Error (status:503): Service Unavailable',
      'Request failed with status:503',
      'HTTP 503 Service Unavailable',
      'overloaded_error: Overloaded',
    ]) {
      const hit = detectLimit(text);
      expect(hit?.kind, text).toBe('transient');
    }
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

describe('detectLimit — escopo de tier (cooldown escopado do oh-my-pi)', () => {
  it('extrai tier:opus de um id de modelo completo perto do erro', () => {
    const hit = detectLimit(
      'Error: 429 Too Many Requests for model claude-opus-4-6',
    );
    expect(hit?.kind).toBe('rate-limit');
    expect(hit?.scope).toBe('tier:opus');
  });

  it('extrai tier pelo nome de família isolado perto do erro', () => {
    const hit = detectLimit(
      'Claude usage limit reached. Opus limit resets at 6pm.',
    );
    expect(hit?.kind).toBe('rate-limit');
    expect(hit?.scope).toBe('tier:opus');
  });

  it('extrai tier no caminho do classificador vendorado', () => {
    const hit = detectLimit(
      'You have exhausted your capacity on claude-fable-5. Your quota will reset after 10pm.',
    );
    expect(hit?.kind).toBe('quota');
    expect(hit?.scope).toBe('tier:fable');
  });

  it('sem menção a modelo → sem escopo (cooldown global da conta)', () => {
    const hit = detectLimit('Error: 429 Too Many Requests');
    expect(hit?.kind).toBe('rate-limit');
    expect(hit?.scope).toBeUndefined();
  });

  it('nome de família longe da vizinhança do erro não vira escopo', () => {
    const filler = 'x'.repeat(300);
    const hit = detectLimit(`Error: 429 Too Many Requests ${filler} sonnet`);
    expect(hit?.kind).toBe('rate-limit');
    expect(hit?.scope).toBeUndefined();
  });
});

describe('F-511: excerpt sanitizado nunca re-dispara failover (anti-drift)', () => {
  // Tela real da morte da sessão (caso de campo 08/09): o pack de failover
  // cita este texto verbatim no pane novo. Sem sanitização, assim que o
  // header do pack sai da janela rolante (4000 chars), o 401 CITADO casa
  // como sinal vivo e o failover entra em ping-pong (loop fantasma).
  const DEATH_SCREEN = [
    'Claude Code v2.1.265 Opus 5 with max effort · Claude API ~/HiperGO',
    'Remote managed settings failed to load (authentication rejected (401))',
    'ERROR: API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
    'Please run /login · Invalid API key · stored token for "oauth" was rejected',
    'Session expired — refresh token revoked, not logged in anymore',
  ].join('\n');

  it('a tela da morte crua AINDA dispara (amostra não é vácua)', () => {
    const hit = detectLimit(DEATH_SCREEN);
    expect(hit?.kind).toBe('auth');
  });

  it('a mesma tela sanitizada não dispara', () => {
    expect(
      detectLimit(sanitizeHandoffExcerptForDetector(DEATH_SCREEN)),
    ).toBeNull();
  });

  it('janela envelhecida (só excerpt + footer, sem header) não dispara', () => {
    // Simula a janela rolante depois que o header saiu: só resta o excerpt
    // sanitizado e o footer benigno.
    const agedWindow = [
      sanitizeHandoffExcerptForDetector(DEATH_SCREEN),
      'Execute the next concrete step now.',
      '-agent working normally below, streaming output…',
    ].join('\n');
    expect(agedWindow).not.toContain('[NEXUS FAILOVER HANDOFF]');
    expect(detectLimit(agedWindow)).toBeNull();
  });

  it('cobre as formas de quota/rate do excerpt também', () => {
    const fuel = [
      'Error: 429 Too Many Requests — rate_limit_exceeded, try again',
      'quota exceeded, usage limit reached, payment required',
    ].join('\n');
    expect(detectLimit(fuel)).not.toBeNull();
    expect(detectLimit(sanitizeHandoffExcerptForDetector(fuel))).toBeNull();
  });
});

describe('tierScopeFromModelId', () => {
  it('classifica ids anthropic em tier via identity classifier', () => {
    expect(tierScopeFromModelId('claude-sonnet-4-5')).toBe('tier:sonnet');
    expect(tierScopeFromModelId('anthropic/claude-fable-5')).toBe('tier:fable');
    expect(tierScopeFromModelId('claude-4-6-opus')).toBe('tier:opus');
  });

  it('não escopa modelos não-anthropic nem entradas vazias', () => {
    expect(tierScopeFromModelId('gpt-5.2-codex')).toBeUndefined();
    expect(tierScopeFromModelId('gemini-3-pro')).toBeUndefined();
    expect(tierScopeFromModelId(undefined)).toBeUndefined();
  });
});

describe('detectLimit — limite de sessão da CLI Claude (2026-09) e reset por horário', () => {
  // Texto real: `claude -p` filho do pane estourou a conta e a ferramenta de
  // shell do Claude Code emoldurou a saída com "⎿". Sem reconhecer isto o
  // failover não trocava de conta (print do operador, 2026-09-27 18:53).
  const real = [
    '⏺ Background command "Rodada final G: pendências da verificação" failed with exit code 1',
    "  ⎿  You've hit your session limit · resets 8:10pm (America/Sao_Paulo)",
    '     Use your limit reset to reset it now: clau.de/reset',
    '     /usage-credits to finish what you’re working on.',
  ].join('\n');
  // 18:53 em São Paulo (UTC-3): faltam 77 min para as 20:10.
  const at1853 = Date.parse('2026-09-27T21:53:00Z');

  it('reconhece "hit your session limit" atrás da moldura ⎿ e mede o cooldown até o reset na zona impressa', () => {
    const hit = detectLimit(real, at1853);
    expect(hit?.kind).toBe('rate-limit');
    expect(hit?.reason).toBe("You've hit your session limit");
    expect(hit?.cooldownMs).toBe(77 * 60 * 1000);
    expect(hit?.scope).toBeUndefined();
  });

  it('horário de reset já passado (scrollback velho) não vira quarentena de um dia: fica o cooldown default', () => {
    const hit = detectLimit(real, Date.parse('2026-09-27T23:30:00Z'));
    expect(hit?.kind).toBe('rate-limit');
    expect(hit?.cooldownMs).toBe(5 * 60 * 60 * 1000);
  });

  it('reset depois da meia-noite conta como amanhã, ainda dentro da janela de 5h', () => {
    const text = "You've hit your session limit · resets 12:30am (America/Sao_Paulo)";
    // 23:50 em São Paulo → 40 min até 00:30 do dia seguinte.
    const hit = detectLimit(text, Date.parse('2026-09-28T02:50:00Z'));
    expect(hit?.cooldownMs).toBe(40 * 60 * 1000);
  });

  it('zona inválida entre parênteses cai na hora local em vez de descartar o hit', () => {
    const text = "You've hit your session limit · resets 3pm (Nowhere/Invalid)";
    const now = new Date(2026, 8, 27, 13, 0).getTime();
    const hit = detectLimit(text, now);
    expect(hit?.kind).toBe('rate-limit');
    expect(hit?.cooldownMs).toBe(2 * 60 * 60 * 1000);
  });

  it('prosa do agente citando a frase no meio da linha não dispara', () => {
    expect(detectLimit('- o helper parou porque hit your session limit ontem', at1853)).toBeNull();
    expect(detectLimit("Se aparecer \"You've hit your session limit\", troque de conta.", at1853)).toBeNull();
  });
});
