/** Envio de e-mail pelo Resend. Não loga nada: nem a chave, nem o destinatário, nem o corpo. */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 10_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ERROR_NAME = /^[a-z][a-z_]{0,59}$/;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResendSenderOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly fetchFn?: FetchFn;
  readonly timeoutMs?: number;
}

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Dedupa reenvios no Resend por 24 h: a mesma chave com o mesmo corpo não sai duas vezes. */
  readonly idempotencyKey: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type SendResult =
  | { readonly ok: true; readonly id: string | null }
  | { readonly ok: false; readonly retryable: boolean; /** 0 quando nem houve resposta (rede, prazo ou mensagem recusada). */ readonly status: number; readonly reason: string };

export interface ResendSender {
  send(message: OutgoingEmail): Promise<SendResult>;
}

/** RFC 8058: o cliente de e-mail mostra "cancelar inscrição" e faz um POST sem abrir página. */
export function oneClickUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

function hasControlCharacters(values: readonly string[]): boolean {
  return values.some(value => CONTROL_CHARACTERS.test(value));
}

function isSafeMessage(message: OutgoingEmail): boolean {
  const headerPairs = Object.entries(message.headers ?? {}).flat();
  return !hasControlCharacters([message.to, message.subject, message.idempotencyKey, ...headerPairs]);
}

async function errorName(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const name = typeof body === 'object' && body !== null ? (body as { name?: unknown }).name : undefined;
    return typeof name === 'string' && ERROR_NAME.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** 429 e 5xx são do lado do provedor e passam sozinhos. O 409 de pedido simultâneo é a mesma chave ainda em voo. */
function isRetryable(status: number, name: string | null): boolean {
  return status === 429 || status >= 500 || (status === 409 && name === 'concurrent_idempotent_requests');
}

async function successId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined;
    return typeof id === 'string' && id.length > 0 && id.length <= 100 ? id : null;
  } catch {
    return null;
  }
}

export function createResendSender(options: ResendSenderOptions): ResendSender {
  if (options.apiKey.trim() === '') throw new TypeError('apiKey ausente');
  if (options.from.trim() === '') throw new TypeError('from ausente');
  const { apiKey, from } = options;
  const fetchFn: FetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async send(message) {
      if (!isSafeMessage(message)) return { ok: false, retryable: false, status: 0, reason: 'invalid_message' };
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const response = await fetchFn(RESEND_ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': message.idempotencyKey },
          body: JSON.stringify({
            from, to: [message.to], subject: message.subject, html: message.html, text: message.text,
            ...(message.headers === undefined ? {} : { headers: message.headers }),
          }),
          signal: controller.signal,
        });
        if (response.ok) return { ok: true, id: await successId(response) };
        const name = await errorName(response);
        return { ok: false, retryable: isRetryable(response.status, name), status: response.status, reason: name === null ? `http_${response.status}` : `http_${response.status}:${name}` };
      } catch {
        return { ok: false, retryable: true, status: 0, reason: timedOut ? 'timeout' : 'network_error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
