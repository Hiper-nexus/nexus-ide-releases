import test from 'node:test';
import assert from 'node:assert/strict';
import { createResendSender, oneClickUnsubscribeHeaders, type OutgoingEmail } from '../src/email/resend.js';

const API_KEY = 're_test_super_secret_key';
const FROM = 'NexusIDE <avisos@nexuside.app>';
const RECIPIENT = 'ana.silva@example.com';
const MESSAGE = { to: RECIPIENT, subject: 'Assunto', html: '<p>oi</p>', text: 'oi', idempotencyKey: 'acc-1:trial_ending_3d' };

interface Call { readonly url: string; readonly init: RequestInit }
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchFn };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sender = (fetchFn: ReturnType<typeof fakeFetch>['fetchFn'], timeoutMs?: number) => createResendSender({ apiKey: API_KEY, from: FROM, fetchFn, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

test('envia POST para a API do Resend com Bearer, JSON e chave de idempotência, e devolve o id', async () => {
  const { calls, fetchFn } = fakeFetch(() => json(200, { id: 'em_123' }));
  const result = await sender(fetchFn).send(MESSAGE);
  assert.deepEqual(result, { ok: true, id: 'em_123' });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call!.url, 'https://api.resend.com/emails');
  assert.equal(call!.init.method, 'POST');
  const headers = new Headers(call!.init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${API_KEY}`);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('idempotency-key'), 'acc-1:trial_ending_3d');
  assert.deepEqual(JSON.parse(String(call!.init.body)), { from: FROM, to: [RECIPIENT], subject: 'Assunto', html: '<p>oi</p>', text: 'oi' });
  assert.ok(call!.init.signal instanceof AbortSignal, 'o envio tem prazo');
});

test('os cabeçalhos de descadastro seguem no corpo, no formato one-click do RFC 8058', async () => {
  const { calls, fetchFn } = fakeFetch(() => json(200, { id: 'em_1' }));
  const url = 'https://api.nexuside.app/v1/notices/unsubscribe?a=acc-1&t=tok';
  assert.deepEqual(oneClickUnsubscribeHeaders(url), { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  await sender(fetchFn).send({ ...MESSAGE, headers: oneClickUnsubscribeHeaders(url) });
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)).headers, { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
});

test('429 e 5xx valem nova tentativa; os demais 4xx não', async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    const result = await sender(fakeFetch(() => json(status, { name: 'rate_limit_exceeded', message: 'x' })).fetchFn).send(MESSAGE);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.retryable, true, String(status)); assert.equal(result.status, status); }
  }
  for (const status of [400, 401, 403, 404, 422]) {
    const result = await sender(fakeFetch(() => json(status, { name: 'validation_error', message: 'x' })).fetchFn).send(MESSAGE);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.retryable, false, String(status)); assert.equal(result.status, status); }
  }
});

test('409 de idempotência: pedido simultâneo vale nova tentativa; mesma chave com corpo diferente não', async () => {
  const concurrent = await sender(fakeFetch(() => json(409, { name: 'concurrent_idempotent_requests', message: 'x' })).fetchFn).send(MESSAGE);
  assert.ok(!concurrent.ok && concurrent.retryable);
  const changed = await sender(fakeFetch(() => json(409, { name: 'invalid_idempotent_request', message: 'x' })).fetchFn).send(MESSAGE);
  assert.ok(!changed.ok && !changed.retryable);
});

test('falha de rede vale nova tentativa e o motivo não carrega chave nem destinatário', async () => {
  const { fetchFn } = fakeFetch(() => { throw new TypeError(`connect failed for ${RECIPIENT} with ${API_KEY}`); });
  const result = await sender(fetchFn).send(MESSAGE);
  assert.deepEqual(result, { ok: false, retryable: true, status: 0, reason: 'network_error' });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${RECIPIENT.replace('.', '\\.')}|${API_KEY}`));
});

test('estourar o prazo aborta a requisição e conta como falha que vale nova tentativa', async () => {
  let aborted = false;
  const fetchFn = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
  });
  const result = await sender(fetchFn, 20).send(MESSAGE);
  assert.deepEqual(result, { ok: false, retryable: true, status: 0, reason: 'timeout' });
  assert.equal(aborted, true);
});

test('o motivo vem só do código do erro: a mensagem do provedor, que pode citar o destinatário, nunca entra', async () => {
  const { fetchFn } = fakeFetch(() => json(422, { name: 'validation_error', message: `Invalid \`to\` field: ${RECIPIENT}` }));
  const result = await sender(fetchFn).send(MESSAGE);
  assert.deepEqual(result, { ok: false, retryable: false, status: 422, reason: 'http_422:validation_error' });
  const hostile = await sender(fakeFetch(() => json(400, { name: `<script>${RECIPIENT}`, message: 'x' })).fetchFn).send(MESSAGE);
  assert.deepEqual(hostile, { ok: false, retryable: false, status: 400, reason: 'http_400' });
  const noBody = await sender(fakeFetch(() => new Response('upstream down', { status: 502 })).fetchFn).send(MESSAGE);
  assert.deepEqual(noBody, { ok: false, retryable: true, status: 502, reason: 'http_502' });
});

test('aceito sem id legível ainda conta como enviado (a chave de idempotência cobre um reenvio)', async () => {
  assert.deepEqual(await sender(fakeFetch(() => new Response('', { status: 200 })).fetchFn).send(MESSAGE), { ok: true, id: null });
  assert.deepEqual(await sender(fakeFetch(() => json(200, { id: 42 })).fetchFn).send(MESSAGE), { ok: true, id: null });
});

test('quebra de linha ou controle em destinatário, assunto, chave ou cabeçalho é recusada antes de qualquer requisição', async () => {
  const { calls, fetchFn } = fakeFetch(() => json(200, { id: 'x' }));
  const s = sender(fetchFn);
  const bad: OutgoingEmail[] = [
    { ...MESSAGE, to: `${RECIPIENT}\r\nBcc: x@y.z` },
    { ...MESSAGE, subject: 'a\nb' },
    { ...MESSAGE, idempotencyKey: 'k\r\nX: y' },
    { ...MESSAGE, headers: { 'List-Unsubscribe': '<https://x>\r\nBcc: a@b.c' } },
    { ...MESSAGE, headers: { 'X-Bad\nName': 'v' } },
  ];
  for (const message of bad) assert.deepEqual(await s.send(message), { ok: false, retryable: false, status: 0, reason: 'invalid_message' });
  assert.equal(calls.length, 0);
});

test('sem chave ou remetente o sender nem nasce', () => {
  assert.throws(() => createResendSender({ apiKey: '', from: FROM }), /apiKey/);
  assert.throws(() => createResendSender({ apiKey: API_KEY, from: '  ' }), /from/);
});
