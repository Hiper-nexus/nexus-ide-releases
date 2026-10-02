import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportSchema, listQuerySchema, patchReportSchema } from '../src/bugs/schemas.js';
import { reportFingerprint } from '../src/bugs/fingerprint.js';
import { decodeCursor, encodeCursor } from '../src/bugs/cursor.js';
import { STATUS_TRANSITIONS, canTransition, eventKindForTransition } from '../src/bugs/transitions.js';
import { BUG_STATUSES } from '../src/bugs/constants.js';

const valid = () => ({
  title: 'Terminal fecha sozinho',
  description: 'Ao abrir três painéis ao mesmo tempo o terminal fecha.',
  category: 'terminal',
  impact: 'blocks_work',
  app: { version: '0.76.110', platform: 'darwin', arch: 'arm64' },
  consent: { diagnostics: false },
});

test('relato válido mínimo passa e a gravidade nem faz parte do corpo', () => {
  const parsed = createReportSchema.safeParse(valid());
  assert.equal(parsed.success, true);
  assert.equal(createReportSchema.safeParse({ ...valid(), severity: 'blocker' }).success, false, 'a gravidade é do admin');
});

test('o esquema é estrito: campo desconhecido em qualquer nível é recusado', () => {
  assert.equal(createReportSchema.safeParse({ ...valid(), extra: 1 }).success, false);
  assert.equal(createReportSchema.safeParse({ ...valid(), app: { ...valid().app, device: 'x' } }).success, false);
  assert.equal(createReportSchema.safeParse({ ...valid(), consent: { diagnostics: true, other: 1 } }).success, false);
  assert.equal(createReportSchema.safeParse({ ...valid(), context: { adapter: 'claude', hack: 1 } }).success, false);
});

test('limites de tamanho do contrato', () => {
  const ok = (patch: Record<string, unknown>) => createReportSchema.safeParse({ ...valid(), ...patch }).success;
  assert.equal(ok({ title: 'abcd' }), false);
  assert.equal(ok({ title: 'abcde' }), true);
  assert.equal(ok({ title: 'a'.repeat(121) }), false);
  assert.equal(ok({ title: 'a'.repeat(120) }), true);
  assert.equal(ok({ description: 'curto' }), false);
  assert.equal(ok({ description: 'a'.repeat(4001) }), false);
  assert.equal(ok({ description: 'a'.repeat(4000) }), true);
  assert.equal(ok({ steps: 'a'.repeat(2001) }), false);
  assert.equal(ok({ steps: 'a'.repeat(2000) }), true);
});

test('categoria, impacto, plataforma e versão só aceitam o que o contrato lista', () => {
  const ok = (patch: Record<string, unknown>) => createReportSchema.safeParse({ ...valid(), ...patch }).success;
  assert.equal(ok({ category: 'seguranca' }), false);
  assert.equal(ok({ impact: 'minor' }), false);
  for (const category of ['crash', 'terminal', 'agents', 'license', 'billing', 'ui', 'performance', 'other']) assert.equal(ok({ category }), true);
  const app = (patch: Record<string, unknown>) => ok({ app: { ...valid().app, ...patch } });
  assert.equal(app({ platform: 'android' }), false);
  assert.equal(app({ version: 'latest' }), false);
  assert.equal(app({ version: '1.2.3-beta.1+build5' }), true);
  assert.equal(app({ version: '1'.repeat(33) }), false);
  assert.equal(app({ arch: 'x'.repeat(17) }), false);
  assert.equal(app({ arch: 'arm 64' }), false);
  assert.equal(app({ osVersion: 'x'.repeat(65) }), false);
});

test('contexto: adapter <= 40, model <= 80, paneCount 0..64 inteiro, missionActive booleano', () => {
  const ok = (context: Record<string, unknown>) => createReportSchema.safeParse({ ...valid(), context }).success;
  assert.equal(ok({ adapter: 'claude', model: 'opus', paneCount: 4, missionActive: true }), true);
  assert.equal(ok({ adapter: 'a'.repeat(41) }), false);
  assert.equal(ok({ model: 'a'.repeat(81) }), false);
  assert.equal(ok({ paneCount: 65 }), false);
  assert.equal(ok({ paneCount: -1 }), false);
  assert.equal(ok({ paneCount: 1.5 }), false);
  assert.equal(ok({ missionActive: 'sim' }), false);
});

test('diagnóstico: até 50 eventos e 20 erros, com tamanhos por campo', () => {
  const ok = (diagnostics: unknown) => createReportSchema.safeParse({ ...valid(), consent: { diagnostics: true }, diagnostics }).success;
  const event = { t: 1_700_000_000_000, kind: 'pty.exit', code: 'ENOENT' };
  assert.equal(ok({ events: Array.from({ length: 50 }, () => event), errors: Array.from({ length: 20 }, () => 'erro') }), true);
  assert.equal(ok({ events: Array.from({ length: 51 }, () => event), errors: [] }), false);
  assert.equal(ok({ events: [], errors: Array.from({ length: 21 }, () => 'erro') }), false);
  assert.equal(ok({ events: [{ ...event, kind: 'k'.repeat(41) }], errors: [] }), false);
  assert.equal(ok({ events: [{ ...event, code: 'c'.repeat(81) }], errors: [] }), false);
  assert.equal(ok({ events: [{ ...event, t: 1.5 }], errors: [] }), false);
  assert.equal(ok({ events: [], errors: ['e'.repeat(201)] }), false);
  assert.equal(ok({ events: [{ ...event, extra: 1 }], errors: [] }), false);
});

test('o esquema já devolve o texto limpo: segredo e caminho somem e quebras no título viram espaço', () => {
  const parsed = createReportSchema.parse({
    ...valid(),
    title: 'Falha\r\nem /Users/fulano/app',
    description: 'Usei sk-proj-AbCdEf1234567890abcdef1234567890 e fulano@x.com',
    steps: 'OPENAI_API_KEY=segredo123\n\n\n\npasso 2',
    app: { ...valid().app, osVersion: 'Darwin 27.2.0 /Users/fulano' },
  });
  const dump = JSON.stringify(parsed);
  assert.doesNotMatch(dump, /fulano|AbCdEf1234567890|segredo123/);
  assert.equal(parsed.title, 'Falha em /Users/[usuario]/app');
  assert.equal(parsed.steps, 'OPENAI_API_KEY=[oculto]\n\npasso 2');
});

test('texto que vira vazio ou curto demais depois da limpeza é recusado', () => {
  assert.equal(createReportSchema.safeParse({ ...valid(), title: '\u200B\u200B\u200B\u200B\u200B\u200B' }).success, false);
  assert.equal(createReportSchema.safeParse({ ...valid(), description: '\u0000'.repeat(12) }).success, false);
});

test('patch do admin: estrito, pelo menos uma mudança, https obrigatório e id de duplicata em UUID', () => {
  const ok = (body: unknown) => patchReportSchema.safeParse(body).success;
  assert.equal(ok({}), false);
  assert.equal(ok({ status: 'triaged' }), true);
  assert.equal(ok({ status: 'open' }), false);
  assert.equal(ok({ severity: 'blocker' }), true);
  assert.equal(ok({ severity: 'critical' }), false);
  assert.equal(ok({ note: 'a'.repeat(2000) }), true);
  assert.equal(ok({ note: 'a'.repeat(2001) }), false);
  assert.equal(ok({ unknown: 1, status: 'triaged' }), false);
  assert.equal(ok({ fixPrUrl: 'https://github.com/org/repo/pull/12' }), true);
  assert.equal(ok({ fixPrUrl: 'http://github.com/org/repo/pull/12' }), false);
  assert.equal(ok({ fixPrUrl: 'javascript:alert(1)' }), false);
  assert.equal(ok({ fixPrUrl: 'https://user:senha@github.com/x' }), false);
  assert.equal(ok({ fixSummary: 'Corrigido o fechamento do terminal.' }), true);
  assert.equal(ok({ fixSummary: 'a'.repeat(2001) }), false);
  assert.equal(ok({ status: 'duplicate', duplicateOf: crypto.randomUUID() }), true);
  assert.equal(ok({ status: 'duplicate', duplicateOf: 'nao-e-uuid' }), false);
});

test('filtros da lista do admin: limite até 100 (padrão 50), enums e busca limitada', () => {
  assert.equal(listQuerySchema.parse({}).limit, 50);
  assert.equal(listQuerySchema.parse({ limit: '100' }).limit, 100);
  assert.equal(listQuerySchema.safeParse({ limit: '101' }).success, false);
  assert.equal(listQuerySchema.safeParse({ limit: '0' }).success, false);
  assert.equal(listQuerySchema.safeParse({ status: 'nope' }).success, false);
  assert.equal(listQuerySchema.safeParse({ status: 'new', category: 'ui', severity: 'low', q: 'terminal' }).success, true);
  assert.equal(listQuerySchema.safeParse({ q: 'a'.repeat(101) }).success, false);
  assert.equal(listQuerySchema.safeParse({ cursor: '%%%' }).success, false);
});

test('fingerprint: igual para o mesmo título depois de normalizar, e diferente por categoria ou por major.minor', async () => {
  const base = { title: 'Terminal fecha sozinho!', category: 'terminal' as const, appVersion: '0.76.110' };
  const fingerprint = await reportFingerprint(base);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(await reportFingerprint({ ...base, title: '  TERMINAL   fecha, sozinho 3 vezes!!! '.replace(' 3 vezes', '') }), fingerprint, 'caixa, pontuação e espaços não contam');
  assert.equal(await reportFingerprint({ ...base, title: 'Terminal fecha sozinho 42' }), fingerprint, 'números não contam');
  assert.equal(await reportFingerprint({ ...base, title: 'Terminal fecha sozinho' }), fingerprint);
  assert.equal(await reportFingerprint({ ...base, title: 'Terminál fecha sózinho' }), fingerprint, 'acentos não contam');
  assert.equal(await reportFingerprint({ ...base, appVersion: '0.76.999' }), fingerprint, 'só major.minor conta');
  assert.notEqual(await reportFingerprint({ ...base, appVersion: '0.77.0' }), fingerprint);
  assert.notEqual(await reportFingerprint({ ...base, category: 'ui' }), fingerprint);
  assert.notEqual(await reportFingerprint({ ...base, title: 'Outro problema qualquer' }), fingerprint);
});

test('cursor da lista: ida e volta, e valor adulterado vira nulo', () => {
  const cursor = encodeCursor({ createdAt: 1_790_766_000_123, id: '3f2b8a52-8d0e-4f0a-9a9a-0123456789ab' });
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(cursor), { createdAt: 1_790_766_000_123, id: '3f2b8a52-8d0e-4f0a-9a9a-0123456789ab' });
  for (const bad of ['', 'abc', '%%%', encodeCursor({ createdAt: -1, id: 'x' }), btoa('1.5:uuid')]) assert.equal(decodeCursor(bad), null, `cursor ruim: ${bad}`);
});

test('transições: o fluxo feliz funciona, e atalhos ilegais são barrados', () => {
  const path = ['new', 'triaged', 'fix_proposed', 'approved', 'fixed', 'released'] as const;
  for (let i = 0; i < path.length - 1; i += 1) assert.equal(canTransition(path[i]!, path[i + 1]!), true, `${path[i]} -> ${path[i + 1]}`);
  assert.equal(canTransition('new', 'released'), false, 'não vai de new direto a released');
  assert.equal(canTransition('new', 'approved'), false);
  assert.equal(canTransition('new', 'fix_proposed'), false, 'a triagem vem antes da proposta');
  assert.equal(canTransition('triaged', 'approved'), false, 'approved exige fix_proposed antes');
  assert.equal(canTransition('triaged', 'released'), false);
  assert.equal(canTransition('fix_proposed', 'released'), false, 'released exige approved');
  assert.equal(canTransition('needs_info', 'approved'), false);
});

test('transições: invariantes da tabela (approved só vem de fix_proposed, released só depois de approved, sem auto-transição)', () => {
  assert.deepEqual(Object.keys(STATUS_TRANSITIONS).sort(), [...BUG_STATUSES].sort());
  const into = (target: string) => BUG_STATUSES.filter(from => canTransition(from, target as never));
  assert.deepEqual(into('approved'), ['fix_proposed']);
  assert.deepEqual(into('released').sort(), ['approved', 'fixed']);
  assert.deepEqual(into('fixed'), ['approved']);
  for (const status of BUG_STATUSES) assert.equal(canTransition(status, status), false, `${status} -> ${status}`);
  for (const terminal of ['released', 'wont_fix', 'duplicate'] as const) assert.deepEqual([...STATUS_TRANSITIONS[terminal]], ['triaged'], `${terminal} só reabre para triaged`);
});

test('tipo do evento na linha do tempo: a aprovação e a liberação têm evento próprio', () => {
  assert.equal(eventKindForTransition('fix_proposed', 'approved'), 'approved');
  assert.equal(eventKindForTransition('approved', 'released'), 'released');
  assert.equal(eventKindForTransition('fixed', 'released'), 'released');
  assert.equal(eventKindForTransition('triaged', 'fix_proposed'), 'fix_proposed');
  assert.equal(eventKindForTransition('new', 'duplicate'), 'duplicate_marked');
  assert.equal(eventKindForTransition('fix_proposed', 'triaged'), 'rejected');
  assert.equal(eventKindForTransition('approved', 'fix_proposed'), 'rejected');
  assert.equal(eventKindForTransition('new', 'triaged'), 'status_changed');
  assert.equal(eventKindForTransition('approved', 'fixed'), 'status_changed');
});
