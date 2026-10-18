import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { detectLimit, tierScopeFromModelId } from './limit-detector';
import {
  FAILOVER_HANDOFF_HEADER,
  buildContinuityPack,
  sanitizeHandoffExcerptForDetector,
} from '../../shared/failover-handoff';

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

  // F-1410: o limite do Muse não era confirmado (operador, 12/10: "muse acabou
  // limite, manda para outro" e a rota respondeu "exclude ignorado (CLI
  // saudável)"). Formatos: rodapé `modelo · esforço · cwd` (Herdr muse.toml) +
  // rótulo `Usage limit reached` e peças da entrada quota-hit (strings do
  // binário 1.4.6); célula de erro literal da sessão Muse de 12/10/2026.
  describe('F-1410: limite de uso do Muse Code', () => {
    const MUSE_ERROR =
      'API error 429 [request_id=0d689170-298c-48aa-a1cb-fa5f21b9ea5b]: Subscription quota exhausted. ' +
      'Your usage window resets at 2026-10-12T21:55:00Z. (rate_limit_error)';

    it.each([
      'muse-spark-1.3 · medium · ~/proj · Usage limit reached',
      'muse-wonder-full-1.0 · max · Usage limit reached',
      'Usage limit reached\nRun /upgrade (https://meta.ai/muse/upgrade) for increased limits, or wait for usage to reset at 6:55 PM',
      '  ● Use /upgrade (https://meta.ai/muse/upgrade) for increased limits',
      MUSE_ERROR,
      `✗ model failed: ${MUSE_ERROR}`,
    ])('célula real da TUI do Muse é limite CONFIRMADO: %s', (screen) => {
      const hit = detectLimit(screen);
      expect(hit?.kind).toBe('rate-limit');
      expect(hit?.adapterId).toBe('muse');
      expect(hit?.confirmed).toBe(true);
    });

    it('o reset ISO da API dimensiona a janela', () => {
      const now = Date.parse('2026-10-12T19:10:14Z');
      expect(detectLimit(MUSE_ERROR, now)?.cooldownMs).toBe(Date.parse('2026-10-12T21:55:00Z') - now);
      // Reset já passado (scrollback antigo) não é reset vivo: piso de 5 h.
      expect(detectLimit(MUSE_ERROR, Date.parse('2026-10-13T00:00:00Z'))?.cooldownMs).toBe(5 * 60 * 60 * 1000);
    });

    it('texto CITADO do mesmo rótulo não confirma nada (F-249)', () => {
      const notConfirmed = (text: string) => expect(detectLimit(text)?.confirmed).toBeUndefined();
      // A frase solta numa linha é o que um `cat erro.log` reproduz: segue
      // limite genérico (sonda decide), nunca confirmado.
      notConfirmed('Usage limit reached');
      expect(detectLimit('Usage limit reached')?.kind).toBe('rate-limit');
      // Prosa citando o rodapé ou o upgrade no meio da frase.
      notConfirmed('O rodapé do muse mostrava muse-spark-1.3 · medium · Usage limit reached.');
      notConfirmed('Segundo o print, ele pediu para usar /upgrade (link) for increased limits ontem.');
      // `cat session.jsonl`: o motivo vem dentro do JSON, não na célula.
      notConfirmed(`{"kind":"terminal","terminal":"failed","reason":"${MUSE_ERROR}"}`);
      // Rótulos do /goal: o orçamento do goal não é a conta.
      expect(detectLimit('usage limited')).toBeNull();
      expect(detectLimit('limited by budget')).toBeNull();
      // Log rotulado, blockquote e fence são descartados.
      expect(detectLimit('Log output: muse-spark-1.3 · medium · Usage limit reached')).toBeNull();
      expect(detectLimit(`> ${MUSE_ERROR}`)).toBeNull();
      expect(detectLimit('```\nmuse-spark-1.3 · medium · Usage limit reached\n```')).toBeNull();
      // Eco do pack de continuidade (neutralizado por construção, F-999).
      const pack = buildContinuityPack({
        fromAccountLabel: 'Muse',
        toAccountLabel: 'Codex',
        reason: 'muse-spark-1.3 · medium · Usage limit reached',
        scrollbackExcerpt: `${MUSE_ERROR}\nRun /upgrade (https://x) for increased limits`,
        limitKind: 'rate-limit',
        limitCooldownMs: 5 * 60 * 60 * 1000,
      });
      expect(detectLimit(pack)).toBeNull();
      expect(detectLimit(pack.replace(FAILOVER_HANDOFF_HEADER, ''))?.confirmed).toBeUndefined();
    });

    it('o limite genérico de outras CLIs segue igual e sem marca', () => {
      const claude = detectLimit('Claude usage limit reached. Resets at 3pm.');
      expect(claude?.kind).toBe('rate-limit');
      expect(claude?.adapterId).toBeUndefined();
      expect(claude?.confirmed).toBeUndefined();
      expect(detectLimit('Error: quota exhausted')?.confirmed).toBeUndefined();
    });
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

  it('F-992: recusa de modelo do Claude Code entra na quarentena de modelo', () => {
    // Texto do 404 nas CLIs 2.1.283 e 2.1.293 (strings do binário).
    const hit = detectLimit(
      "  ⎿  API Error: There's an issue with the selected model (claude-haiku-5-5). It may not exist or you may not have access to it. Run /model to pick a different model.",
    );
    expect(hit?.kind).toBe('model');
    expect(hit?.reason).toContain('(claude-haiku-5-5)');
    // Prosa citando o problema sem a frase canônica não dispara.
    expect(detectLimit('Acho que há um problema com o modelo selecionado; vou trocar.')).toBeNull();
    expect(detectLimit('There is an issue with the selected model, maybe.')).toBeNull();
  });

  it.each([
    "Error: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account",
    'Error: The gpt-6.1-sol model is not supported when using Codex with a ChatGPT account',
    'HTTP 400: model is not supported when using Codex with a ChatGPT account',
    'Error: HTTP 400: model is not supported when using Codex with a ChatGPT account',
    `{"error":{"message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account","type":"invalid_request_error"}}`,
  ])('F-765: recusa real Codex/ChatGPT é modelo, não limite da conta: %s', (text) => {
    expect(detectLimit(text)?.kind).toBe('model');
  });

  it('F-765: recusa Codex citada em handoff, documentação ou narração não dispara', () => {
    const error = "Error: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account";
    for (const text of [
      `> Handoff: ${error}`,
      `O pane antigo retornou ${error}; já foi corrigido.`,
      `Documentação: ${error}`,
      `\`\`\`text\n${error}\n\`\`\``,
      `A documentação cita \`${error}\` como exemplo.`,
      sanitizeHandoffExcerptForDetector(error),
      "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account",
      'Error: this feature is not supported',
    ]) expect(detectLimit(text)).toBeNull();
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
    // F-1567: a string EXATA do Qwen Code no incidente (hífen em "API-key") —
    // é credencial recusada (auth), nunca quota/rate-limit. Quem a reconhece é
    // a moldura "Error: 401" (padrão de 401 acima), não a frase solta.
    const qwen401 = detectLimit(
      '[API Error: 401 Invalid API-key provided. For details, see: ' +
        'https://www.alibabacloud.com/help/en/model-studio/error-code#apikey-error (request_id: abc)]',
    );
    expect(qwen401?.kind).toBe('auth');
    expect(
      detectLimit(
        'Error: [internal] Stored token for "kimi-code" was rejected; re-login required.',
      )?.kind,
    ).toBe('auth');
  });

  it('F-1569: "Login expired · Please run /login" do Claude 2.1.302 é auth', () => {
    // Tela do Maestro em 18/10 18:32: a CLI imprime só esta célula, sem 401.
    for (const screen of [
      '● Login expired · Please run /login',
      'Brewed for 3m\n  ⎿  Login expired · Please run /login\n',
      'Login expired · Run /login to sign in again, or re-authenticate your Anthropic profile',
    ]) {
      const hit = detectLimit(screen);
      expect(hit?.kind).toBe('auth');
      expect(hit?.cooldownMs).toBe(15 * 60 * 1000);
    }
  });

  it('F-1569: a frase citada em prosa, handoff ou pack de continuidade não arma failover', () => {
    expect(detectLimit('o Maestro mostrou "Login expired · Please run /login" e parou')).toBeNull();
    expect(detectLimit('> ● Login expired · Please run /login')).toBeNull();
    expect(detectLimit('login expired · please run /login')).toBeNull();
    expect(
      detectLimit(sanitizeHandoffExcerptForDetector('● Login expired · Please run /login')),
    ).toBeNull();
  });

  it('F-249: "Invalid API-key" com hífen sem a moldura de erro é prosa, log ou cat do código — não arma failover', () => {
    // A frase solta aparece na doc do provider, em log colado, em diff e no
    // `cat` deste próprio detector; só a moldura "Error: 401"/"[API Error: 401"
    // (acima) a transforma em credencial recusada.
    expect(detectLimit('Invalid API-key provided.')).toBeNull();
    expect(detectLimit('o provider devolve "Invalid API-key provided" quando a chave expira')).toBeNull();
    expect(detectLimit("+    expect(detectLimit('Invalid API-key provided.')?.kind).toBe('auth');")).toBeNull();
    expect(detectLimit('grep -rn "Invalid API-key" src/')).toBeNull();
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

  it('F-1357: limite com nome do provider usa a janela do provider, não a genérica de 1 h', () => {
    const fiveHours = 5 * 60 * 60 * 1000;
    expect(detectLimit('grok rate limit reached')?.cooldownMs).toBe(fiveHours);
    expect(detectLimit('xAI rate limit exceeded')?.cooldownMs).toBe(fiveHours);
    expect(detectLimit('Grok rate limit exceeded, try later')?.cooldownMs).toBe(fiveHours);
    expect(detectLimit('codex: ChatGPT rate limit hit')?.cooldownMs).toBe(fiveHours);
    // Sem o provider, o genérico segue com 1 h.
    expect(detectLimit('rate limit reached')?.cooldownMs).toBe(60 * 60 * 1000);
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

describe('F-1019: sinal de limite só nasce da fonte compartilhada (anti-drift)', () => {
  /**
   * `quotedLimitSignalPatterns` neutraliza o texto citado com as fontes que o
   * detector importa (tabela de `shared/limit-signal-patterns`, classify do
   * omp, frase do Codex). Uma regex de sinal escrita AQUI dispararia no eco do
   * pack sem nunca ser neutralizada. Cada regex deste arquivo é auxiliar
   * (reset, escopo, Markdown, célula do Codex) e está listada com o lugar
   * onde mora; regex nova = padrão de limite vai para a tabela compartilhada,
   * auxiliar entra nesta lista.
   */
  const AUXILIARY = [
    'BARE_ANTHROPIC_FAMILY /\\b(opus|sonnet|haiku|fable|mythos)\\b/i',
    'CLAUDE_MODEL_ID /\\bclaude-[a-z0-9][a-z0-9.-]*/i',
    'CLIENT_RETRY_TICKER /\\bretrying\\s+in\\s+\\d+(?:\\.\\d+)?\\s*(?:ms|milliseconds?|secs?|seconds?|s)\\s*[·|•\\-]\\s*attempt\\s+\\d+\\s*\\/\\s*\\d+/gi',
    'mins /try again in (\\d+)\\s*(?:minute|min)/i',
    'secs /try again in (\\d+)\\s*(?:second|sec)/i',
    'hrs /(?:resets?|available again) in (\\d+)\\s*hour/i',
    'm /\\bresets?\\s+(?:at\\s+)?(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2}))/i',
    'm /\\bresets?\\s+(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b(?:\\s*\\(([^)]{1,64})\\))?/i',
    'BLOCKQUOTE_LINE /^[ \\t]{0,3}(?:>[ \\t]?)+/',
    'FENCE_LINE /^[ \\t]{0,3}(`{3,}|~{3,})(.*)$/',
    'match /^[ \\t]{0,3}(`{3,}|~{3,})[ \\t]*$/',
    'lines /\\r?\\n/',
    'CODEX_REJECTION_PHRASE /\\s+/g',
    'CODEX_REJECTION_PHRASE_RE new RegExp',
    'CODEX_ERROR_CELL_START /[ \\t⎿│]*(?:■|(?:api[ \\t]+)?error:|http[ \\t]*400:|unexpected[ \\t]+status[ \\t]+400\\b|\\{[ \\t]*"(?:type|error)"[ \\t]*:)/iy',
    'CODEX_REJECTION_CELL new RegExp',
    'compact /\\s+/g',
    'codexChatGptModelRejection /\\s/',
    'cell /\\s+/g',
    'detectLimit /^[\\s⎿│]+/u',
    'detectLimit /^\\s*[:=]\\s*(?:false|null|0\\b)/i',
  ].sort();

  it('nenhuma regex de sinal mora no detector fora da tabela compartilhada', () => {
    const file = fileURLToPath(new URL('./limit-detector.ts', import.meta.url));
    const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const owner = (node: ts.Node): string => {
      for (let at = node.parent; at; at = at.parent) {
        if ((ts.isVariableDeclaration(at) || ts.isFunctionDeclaration(at)) && at.name && ts.isIdentifier(at.name)) {
          return at.name.text;
        }
      }
      return '<módulo>';
    };
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) found.push(`${owner(node)} ${node.getText(tree)}`);
      if (ts.isNewExpression(node) && node.expression.getText(tree) === 'RegExp') found.push(`${owner(node)} new RegExp`);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(found.sort()).toEqual(AUXILIARY);
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
      // F-775: a frase da OpenAI na ordem inversa também é mascarada.
      'You exceeded your current quota, please check your plan and billing details.',
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

describe('F-718: estrangulamento que a CLI do Kimi administra sozinha', () => {
  const swarm = [
    'Agent swarm · 3 agents',
    '  ⣿⣿⣿⣿⣿⣿  Completed',
    '  ⣤⣀⣀⣀⣀⣀  Rate limited…',
    '  ⣀⣀⣀⣀⣀⣀  Queued…',
  ].join('\n');

  it.each([
    // Painel do enxame (SUSPENDED_LABEL): subagente re-enfileirado com backoff.
    '⣿⣿⣶⣀⣀⣀  Rate limited…  explore-api   ━━━━━━',
    swarm,
    'Provider rate limit; subagent requeued for retry.',
    // Tower: pausa de spawns por segundos, recuperada sozinha.
    'provider rate limit hit — new tower spawns paused for ~12s. Successful requests lift the pause early; wait and retry, or let running agents finish first.',
    ['provider rate limit hit — new tower spawns paused', 'for ~12s. Successful requests lift the pause early'].join('\n'),
    'budget: 4 agent(s) · inflight: 4 · spawns PAUSED for ~9s (provider rate limit — successful requests lift the pause early)',
  ])('não é limite da conta: %s', (text) => {
    expect(detectLimit(text)).toBeNull();
  });

  it('um 429 real depois do painel do enxame continua detectado', () => {
    const hit = detectLimit([swarm, 'Error: 429 Too Many Requests'].join('\n'));
    expect(hit?.kind).toBe('rate-limit');
  });

  it('"Rate limited" de outra CLI, sem as reticências do rótulo do Kimi, continua detectado', () => {
    expect(detectLimit('Error: Rate limited by provider')?.kind).toBe('rate-limit');
    expect(detectLimit('Rate limited. Please wait before retrying.')?.kind).toBe('rate-limit');
  });
});

/**
 * F-764 (03/10): três padrões de início de linha (`^[\s⎿│]*…\s*`) ficavam
 * cúbicos numa tela de TUI em branco — 300 ms por janela de 4 KB, a cada chunk
 * de PTY — e congelaram a main thread com 12 panes vivos. detectLimit também
 * recebe texto de hook e de sonda de cota sem limite de tamanho, então a
 * varredura tem de ser linear em qualquer entrada.
 */
describe('F-764: varredura linear em texto de TUI', () => {
  const SIZE = 16_384;
  const rows = (row: () => string, count: number) =>
    Array.from({ length: count }, row).join('\n').slice(-SIZE);
  const inputs: Array<[string, string]> = [
    ['tela em branco', rows(() => ' '.repeat(131), 140)],
    ['caixa de input │…│', rows(() => `│${' '.repeat(129)}│`, 140)],
    ['moldura ⎿ e espaços', rows(() => `  ⎿${' '.repeat(128)}`, 140)],
    ['espaço sem quebra (cursor absoluto)', ' '.repeat(SIZE)],
    ['tabs e espaços', '\t \t '.repeat(SIZE / 4)],
    ['só quebras de linha', '\n'.repeat(SIZE)],
    ['"error" seguido de espaço', `error${' '.repeat(SIZE - 5)}`],
    ['"status code" seguido de espaço', `status code${' '.repeat(SIZE - 11)}`],
    ['moldura de shell │ ⎿', rows(() => `  │  ⎿${' '.repeat(120)}`, 140)],
  ];

  it.each(inputs)('%s: nenhum limite, em tempo linear', (_label, text) => {
    // Aquece: a compilação/tier-up da regex não é o que está sendo medido.
    detectLimit(text);
    const startedAt = performance.now();
    const hit = detectLimit(text);
    const elapsedMs = performance.now() - startedAt;
    expect(hit).toBeNull();
    // Linear fica em ~1 ms; a versão cúbica passava de segundos neste tamanho.
    expect(elapsedMs).toBeLessThan(50);
  });

  const nbsp = String.fromCharCode(0xa0);
  it.each([
    '  ⎿  Claude usage limit reached. Your limit will reset at 3pm.',
    '│ Error: usage limit reached',
    `${nbsp}${nbsp}You have reached your daily limit.`,
    "saída anterior\n    You've hit your usage limit · resets 8pm",
    'error:\n  usage limit reached',
    '\tclaude\tusage limit reached!',
  ])('moldura de linha continua reconhecida: %s', (text) => {
    expect(detectLimit(text)?.kind).toBe('rate-limit');
  });

  it.each([
    ['HTTP 429', 'rate-limit'],
    ['status code:   429', 'rate-limit'],
    ['status =429', 'rate-limit'],
    ['error:\t402', 'quota'],
    ['Error: 401 Unauthorized', 'auth'],
  ])('código de status com ou sem separador continua reconhecido: %s', (text, kind) => {
    expect(detectLimit(text)?.kind).toBe(kind);
  });

  it('rótulo de log com espaço antes do separador continua sendo histórico', () => {
    expect(detectLimit('stdout   :   Error: 429 Too Many Requests')).toBeNull();
  });
});

/**
 * F-765 (03/10): o Codex 0.146 com conta ChatGPT recusou o gpt-6.1-sol. A TUI
 * quebra a célula de erro em várias linhas sozinha (print do operador), então
 * a frase chega ao PTY partida — a regex de uma linha só nunca casou a tela.
 */
describe('F-765: recusa de modelo do Codex com conta ChatGPT', () => {
  // Linhas exatas do print do operador (pane estreito), com o marcador ■.
  const SCREEN = [
    '⚠ Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata;',
    '  this can degrade performance and cause issues.',
    '',
    '• You have 3 usage limit resets available. Run /usage to use one.',
    '',
    '■ {"type":"error","status":400,"error":',
    '{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not',
    'supported when using Codex with a ChatGPT account."}}',
  ].join('\n');

  it('a tela real (célula de erro em três linhas) é recusa de modelo, presa ao Codex', () => {
    const hit = detectLimit(SCREEN);
    expect(hit).toMatchObject({ kind: 'model', adapterId: 'codex' });
    expect(hit?.reason).toBe(
      "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account",
    );
  });

  it.each([
    // Linha única (exec, log de rollout).
    '■ {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}',
    // Quebra no meio da palavra (largura diferente do pane).
    '■ {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supp\norted when using Codex with a Chat\nGPT account."}}',
    // Quebra no id do modelo e moldura de ferramenta de shell.
    '  ⎿  ■ {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-\nsol\' model is not supported when using Codex with a ChatGPT account."}}',
    'ERROR: unexpected status 400 Bad Request: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported\nwhen using Codex with a ChatGPT account."}}',
    'Error: The gpt-6.1-sol model is not supported when\n  using Codex with a ChatGPT account',
  ])('variante de tela reconhecida: %s', (text) => {
    expect(detectLimit(text)).toMatchObject({ kind: 'model', adapterId: 'codex' });
  });

  it.each([
    // Linha em branco separa o marcador da frase: são blocos diferentes.
    '■ {"type":"error","status":400}\n\nThe \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account.',
    // Frase longe demais do marcador (mais linhas que uma célula de erro).
    ['Error: falhou', 'a', 'b', 'c', 'd', 'e', 'f', "The 'x' model is not supported when using Codex with a ChatGPT account"].join('\n'),
    // Prosa quebrada pela TUI: a linha da frase não abre com marcador de erro.
    'O Maestro explicou que o pane mostrava a mensagem\nde que o model is not supported when using Codex with a ChatGPT account.',
    // A frase sem o "model" na frente não é a recusa.
    'Error: this account is not supported when using Codex with a ChatGPT account',
  ])('não é célula de erro do Codex: %s', (text) => {
    expect(detectLimit(text)).toBeNull();
  });

  it('a tela real mascarada no excerpt do pack (inteira ou com espaços colapsados) não dispara', () => {
    expect(detectLimit(sanitizeHandoffExcerptForDetector(SCREEN))).toBeNull();
    const collapsed = SCREEN.replace(/\s+/g, ' ');
    expect(detectLimit(sanitizeHandoffExcerptForDetector(collapsed))).toBeNull();
    const midWord = '■ {"type":"error","message":"The \'gpt-6.1-sol\' model is not supp orted when using Codex with a Chat GPT account."}}';
    expect(detectLimit(midWord)?.kind).toBe('model');
    expect(detectLimit(sanitizeHandoffExcerptForDetector(midWord))).toBeNull();
  });

  const SIZE = 16_384;
  const phrase = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
  const adversarial: Array<[string, string, 'model' | null]> = [
    ['só marcadores ■ em linhas curtas', '■\n'.repeat(SIZE / 2), null],
    ['"error:" e espaços em todas as linhas', `error:${' '.repeat(120)}\n`.repeat(140).slice(0, SIZE), null],
    ['JSON de erro sem message, frase longe', `{"type":"error",${' '.repeat(600)}\n`.repeat(25).slice(0, SIZE - 100) + phrase, null],
    ['frase em prosa repetida, sem marcador', `o pane disse ${phrase}\n`.repeat(200).slice(0, SIZE), null],
    ['frase letra a letra com espaços', `${phrase.split('').join(' ')}\n`.repeat(100).slice(0, SIZE), null],
    ['moldura │ ⎿ e linhas em branco', `  │  ⎿${' '.repeat(120)}\n\n`.repeat(130).slice(0, SIZE), null],
    ['célula de erro real repetida', `■ {"type":"error","message":"${phrase}"}\n`.repeat(200).slice(-SIZE), 'model'],
  ];

  it.each(adversarial)('%s: tempo linear em 16 KB', (_label, text, kind) => {
    detectLimit(text);
    const startedAt = performance.now();
    const hit = detectLimit(text);
    const elapsedMs = performance.now() - startedAt;
    expect(hit?.kind ?? null).toBe(kind);
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe('F-1427: célula de erro de provedor/rede da própria CLI', () => {
  // Tela real do MiniMax Code (13/10/2026): o pane ficou idle_prompt parado.
  const MINIMAX_SCREEN = [
    '⏺ Vou começar lendo o supervisor do F-1414.',
    '',
    '× Error  The response failed.',
    'Reason: [Error] Connection error.',
    'Run /retry to resend your last message. Your prompt is preserved.',
    '× Error  The model provider is temporarily unavailable.',
    'Code: 50113',
    '',
    '> ',
  ].join('\n');

  it('reconhece o rodapé do MiniMax Code como erro transitório do provedor', () => {
    const hit = detectLimit(MINIMAX_SCREEN);
    expect(hit).toMatchObject({ kind: 'transient' });
    expect(hit?.reason).toContain('The response failed');
    // Nunca vira limite de conta/CLI: sem marca de confirmação.
    expect(hit?.confirmed).toBeUndefined();
  });

  it.each([
    ['provedor indisponível', '  ✗ Error: The model provider is temporarily unavailable.'],
    ['erro de conexão', '× Error  Connection error.'],
    ['serviço sobrecarregado', '× Error  The service is temporarily overloaded'],
    ['motivo de rede', 'Reason: [Error] socket hang up'],
  ])('célula genérica no começo da linha: %s', (_label, line) => {
    expect(detectLimit(`resposta parcial\n${line}\n> `)?.kind).toBe('transient');
  });

  it.each([
    ['frase solta no meio da linha (log)', '2026-10-13 12:00:01 WARN upstream: The model provider is temporarily unavailable (retrying)'],
    ['asserção de teste', "    expect(screen).toContain('× Error  The response failed.');"],
    ['saída de ferramenta emoldurada', '  ⎿  × Error  The response failed.'],
    ['caixa de ferramenta', '│ Reason: [Error] Connection error.'],
    ['nome de teste do vitest', ' × src/main/x.test.ts > shows Connection error 12ms'],
    ['prosa do agente', 'O MiniMax mostrou "Connection error" e "The response failed" no rodapé.'],
    ['bloco citado', '```\n× Error  The response failed.\n```'],
    ['recuo de código', '        × Error  Connection error.'],
  ])('não dispara em texto de erro fora da célula da CLI: %s', (_label, text) => {
    expect(detectLimit(text)).toBeNull();
  });
});
