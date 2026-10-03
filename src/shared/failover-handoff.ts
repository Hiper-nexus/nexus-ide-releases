/**
 * Stable markers for the multi-account failover continuity pack.
 *
 * The pack is Nexus's own text, injected into the replacement pane's PTY after
 * a cross-account switch. It quotes the prior limit reason and a scrollback
 * excerpt of the previous terminal — both carry verbatim provider error phrases.
 * The failover limit-detector taps that same PTY, so it MUST recognise and skip
 * this self-authored block; otherwise it re-fires on every replacement account,
 * cascading the whole fleet into cooldown (the phantom-limit loop).
 *
 * Shared between the renderer builder (`failover-continuity.ts`) and the main
 * detector (`limit-detector.ts`) so the two never drift apart.
 */

/** First line of every continuity pack. */
export const FAILOVER_HANDOFF_HEADER = '[NEXUS FAILOVER HANDOFF]';

/** Last line of every continuity pack. */
export const FAILOVER_HANDOFF_FOOTER = 'Execute the next concrete step now.';

/**
 * Espelho de citação dos gatilhos de `limit-detector.ts` (F-511).
 *
 * O detector varre uma janela rolante de 4000 chars: quando o header do pack
 * sai da janela mas o excerpt ainda está nela, o 401 CITADO da sessão morta
 * casa como sinal vivo e o failover re-dispara sozinho — ping-pong entre
 * contas saudáveis com toasts falsos de "limite atingido". A faixa
 * header→footer só protege DURANTE o streaming; depois disso, só o texto
 * neutro salva.
 *
 * Por isso o excerpt é sanitizado NO BUILD: as formas de erro viram citação
 * marcada, ilegíveis para o detector mas legíveis para o agente. O motivo
 * na 2ª linha também precisa das máscaras quando o header sai da tela. Se um
 * padrão novo entrar no detector, a máscara correspondente entra aqui — o
 * teste anti-drift (`failover-phantom` no lado main) quebra se divergirem.
 */
const EXCERPT_TRIGGER_MASKS: ReadonlyArray<readonly [RegExp, string]> = [
  // Códigos emoldurados (o detector exige framing http/status/error).
  // Grupo nomeado: '$<framing>4xx' preserva o framing sem a ambiguidade de '$14xx'.
  [
    /(?<framing>http(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*(?:[:=]\s*)?|error\s*(?:[:=]\s*)?)40[12]\b/gi,
    '$<framing>4xx',
  ],
  [
    /(?<framing>http(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*(?:[:=]\s*)?|error\s*(?:[:=]\s*)?)429\b/gi,
    '$<framing>4xx',
  ],
  [/401\s+unauthorized/gi, '4xx Unauthorized'],
  [/authentication[_\s]?error/gi, 'authentication_issue'],
  // Par combinado antes das formas isoladas: `rate limit … try again`
  // (ponte de até 24 chars no detector) recasaria mesmo mascarado em partes.
  // `rate cap` proposital: o detector casa `rate[-_\s]?limit` (o vendorado omp
  // INCLUI hífen), então a reposição precisa quebrar o token — hífen ou
  // colchete sozinhos rearmam uma das duas taxonomias.
  [
    /rate[_\s]?limit[_\s]+(?:exceeded|reached|hit)\b.{0,30}\btry again\b/gi,
    'rate cap [citado — ver motivo]',
  ],
  [
    /rate[-_\s]?limit(?:ed|_error)\b|rate[-_\s]?limit[-_\s]+(?:exceeded|reached|hit)\b|ratelimiterror/gi,
    'rate cap [citado]',
  ],
  [/too many requests/gi, '[muitas requisições — citado]'],
  [/resource[_\s]?exhausted/gi, 'resource [esgotado — citado]'],
  [/oauth access token has expired/gi, 'oauth access token [expirado — citado]'],
  [/oauth token (?:expired|revoked)/gi, 'oauth token [expirado — citado]'],
  [/refresh token (?:expired|invalid|revoked)/gi, 'refresh token [inválido — citado]'],
  [/stored token for (["'])[^"']+\1 was rejected/gi, 'stored token [rejeitado — citado]'],
  [/please run \/login/gi, 'run /login [citado]'],
  [/not logged in/gi, 'not-logged-in [citado]'],
  [/session expired/gi, 'session [expirada — citada]'],
  [/invalid[_\s]?(?:api[_\s]?key|x-api-key)/gi, 'invalid [api-key citada]'],
  [/(usage|5-hour|daily|token) limit (?:reached|exceeded|hit)/gi, '$1 limit [citado]'],
  [/quota (?:exceeded|exhausted)/gi, 'quota [esgotada — citada]'],
  [/payment required/gi, '[pagamento — citado]'],
  [/(n[aã]o autenticado|sess[aã]o expirada|token inv[aá]lido)/gi, '[$1 — citado]'],
  [/limite de (?:uso|utiliza[cç][aã]o) (?:atingido|excedido|alcan[cç]ado)/gi, '[limite de uso — citado]'],
];

export function sanitizeHandoffExcerptForDetector(raw: string): string {
  let out = raw;
  for (const [pattern, replacement] of EXCERPT_TRIGGER_MASKS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
