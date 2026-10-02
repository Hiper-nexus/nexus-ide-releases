/**
 * Regras puras do painel "Relatos de bugs" do /admin/. Sem DOM e sem rede: o que a tela mostra e envia é decidido aqui e
 * testado. Espelha o contrato do servidor (nexus-cloud-api, src/bugs/*): estados e transições, campos exigidos por passo,
 * limites e formato das respostas. Texto do relato é ENTRADA NÃO CONFIÁVEL: aqui só é validado e descrito; a tela o
 * escreve por textContent, nunca como HTML.
 */

export const STATUS_LABELS = Object.freeze({
  new: 'Novo', triaged: 'Triado', needs_info: 'Aguardando informação', fix_proposed: 'Correção proposta', approved: 'Correção autorizada',
  fixed: 'Corrigido', released: 'Liberado', wont_fix: 'Não será corrigido', duplicate: 'Duplicado',
});
export const SEVERITY_LABELS = Object.freeze({ low: 'Baixa', medium: 'Média', high: 'Alta', blocker: 'Bloqueia' });
export const CATEGORY_LABELS = Object.freeze({
  crash: 'Travamento', terminal: 'Terminal', agents: 'Agentes', license: 'Licença', billing: 'Cobrança', ui: 'Interface', performance: 'Desempenho', other: 'Outro',
});
export const IMPACT_LABELS = Object.freeze({ annoying: 'Atrapalha', blocks_work: 'Impede de trabalhar' });
export const PLATFORM_LABELS = Object.freeze({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' });
export const EVENT_LABELS = Object.freeze({
  created: 'Enviado', status_changed: 'Status', severity_changed: 'Gravidade', note: 'Nota', duplicate_marked: 'Duplicata', fix_proposed: 'Correção proposta',
  approved: 'Autorizado', rejected: 'Recusado', released: 'Liberado',
});

/** Espelho de STATUS_TRANSITIONS do servidor. O servidor continua sendo a autoridade (responde 409 se divergir). */
export const STATUS_TRANSITIONS = Object.freeze({
  new: ['triaged', 'needs_info', 'wont_fix', 'duplicate'],
  triaged: ['needs_info', 'fix_proposed', 'wont_fix', 'duplicate'],
  needs_info: ['triaged', 'wont_fix', 'duplicate'],
  fix_proposed: ['approved', 'triaged', 'wont_fix'],
  approved: ['fixed', 'released', 'fix_proposed', 'wont_fix'],
  fixed: ['released', 'triaged'],
  released: ['triaged'],
  wont_fix: ['triaged'],
  duplicate: ['triaged'],
});

export const LIMITS = Object.freeze({ page: 50, query: 100, note: 2000, fixSummary: 2000, fixPrUrl: 500 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,120}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string';

export function nextStatuses(status) {
  return (STATUS_TRANSITIONS[status] ?? []).map(next => ({ status: next, label: STATUS_LABELS[next] }));
}

/** O que o servidor exige para ir de `from` a `to`. `confirm` é o texto da confirmação humana (autorizar a correção). */
export function actionRequirements(from, to) {
  const proposing = from === 'triaged' && to === 'fix_proposed';
  return {
    fixSummary: proposing || to === 'approved',
    duplicateOf: to === 'duplicate',
    confirm: to === 'approved' ? 'Você está autorizando esta correção. Fica registrado que foi você quem autorizou, e é isso que libera qualquer correção automática futura.' : null,
  };
}

export function listQuery(filters = {}) {
  const params = new URLSearchParams({ limit: String(LIMITS.page) });
  if (filters.status in STATUS_LABELS) params.set('status', filters.status);
  if (filters.category in CATEGORY_LABELS) params.set('category', filters.category);
  if (filters.severity in SEVERITY_LABELS) params.set('severity', filters.severity);
  const q = isText(filters.q) ? filters.q.trim().slice(0, LIMITS.query) : '';
  if (q !== '') params.set('q', q);
  if (isText(filters.cursor) && CURSOR.test(filters.cursor)) params.set('cursor', filters.cursor);
  return params.toString();
}

/** Só https sem credenciais vira link; qualquer outra coisa (inclusive javascript:) fica como texto. */
export function safeHttpsUrl(value) {
  if (!isText(value) || value === '' || value.length > LIMITS.fixPrUrl) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null;
  } catch { return null; }
}

const fail = (field, error) => ({ ok: false, field, error });

/** Valores do formulário → corpo do PATCH, ou o primeiro erro com o campo. `current` é o relato aberto. */
export function patchBody(current, values) {
  const body = {};
  const status = isText(values.status) && values.status !== '' ? values.status : null;
  if (status !== null) {
    if (!(STATUS_TRANSITIONS[current.status] ?? []).includes(status)) return fail('status', 'Esta mudança de status não é permitida a partir do estado atual.');
    body.status = status;
  }
  const requirements = status === null ? { fixSummary: false, duplicateOf: false } : actionRequirements(current.status, status);

  const summary = isText(values.fixSummary) ? values.fixSummary.trim() : '';
  if (summary.length > LIMITS.fixSummary) return fail('fixSummary', `A correção pode ter até ${LIMITS.fixSummary} caracteres.`);
  if (summary !== '' && summary !== current.fixSummary) body.fixSummary = summary;
  if (requirements.fixSummary && summary === '' && !current.fixSummary) return fail('fixSummary', status === 'approved' ? 'Não há correção proposta para autorizar. Descreva-a antes.' : 'Descreva a correção proposta antes de enviar.');
  if (requirements.fixSummary && summary === '' && current.fixSummary && status === 'approved') { /* usa a correção já proposta */ }

  const prUrl = isText(values.fixPrUrl) ? values.fixPrUrl.trim() : '';
  if (prUrl !== '') {
    const safe = safeHttpsUrl(prUrl);
    if (safe === null) return fail('fixPrUrl', 'Use um link https, sem usuário e senha.');
    if (safe !== current.fixPrUrl) body.fixPrUrl = safe;
  }

  if (requirements.duplicateOf) {
    const original = isText(values.duplicateOf) ? values.duplicateOf.trim() : '';
    if (!UUID.test(original)) return fail('duplicateOf', 'Informe o código do relato original (o identificador completo).');
    body.duplicateOf = original;
  }

  const severity = isText(values.severity) && values.severity !== '' ? values.severity : null;
  if (severity !== null) {
    if (!(severity in SEVERITY_LABELS)) return fail('severity', 'Gravidade inválida.');
    if (severity !== current.severity) body.severity = severity;
  }

  const note = isText(values.note) ? values.note.trim() : '';
  if (note.length > LIMITS.note) return fail('note', `A nota pode ter até ${LIMITS.note} caracteres.`);
  if (note !== '') body.note = note;

  if (Object.keys(body).length === 0) return fail('status', 'Escolha uma ação, uma gravidade ou escreva uma nota.');
  return { ok: true, body };
}

function validListItem(item) {
  return isObject(item) && UUID.test(String(item.id)) && isText(item.title)
    && item.status in STATUS_LABELS && item.severity in SEVERITY_LABELS && item.category in CATEGORY_LABELS
    && isText(item.appVersion) && isText(item.platform) && ISO.test(String(item.createdAt)) && Number.isInteger(item.occurrences);
}

/** Item fora do formato é descartado: um dado estranho do servidor nunca derruba a tela. */
export function parseListResponse(data) {
  if (!isObject(data) || !Array.isArray(data.reports)) return { reports: [], nextCursor: null };
  return { reports: data.reports.filter(validListItem), nextCursor: isText(data.nextCursor) && CURSOR.test(data.nextCursor) ? data.nextCursor : null };
}

function validEvent(event) {
  return isObject(event) && isText(event.id) && event.kind in EVENT_LABELS && isObject(event.details) && ISO.test(String(event.createdAt));
}

export function parseDetailResponse(data) {
  if (!isObject(data) || !isObject(data.report) || !UUID.test(String(data.report.id)) || !isText(data.report.title) || !isText(data.report.description)) return null;
  if (!(data.report.status in STATUS_LABELS) || !Array.isArray(data.events)) return null;
  return { report: data.report, events: data.events.filter(validEvent) };
}

const who = event => (isObject(event.actor) && isText(event.actor.email) ? event.actor.email : 'Alguém');
const labelOf = (labels, key) => labels[key] ?? String(key);

/** Uma frase curta e sem HTML para cada evento da linha do tempo. */
export function describeEvent(event) {
  const d = event.details ?? {};
  switch (event.kind) {
    case 'created': return d.diagnostics === true ? 'Relato enviado, com diagnóstico.' : 'Relato enviado.';
    case 'status_changed': return `${who(event)} mudou o status de ${labelOf(STATUS_LABELS, d.from)} para ${labelOf(STATUS_LABELS, d.to)}.`;
    case 'severity_changed': return `Gravidade de ${labelOf(SEVERITY_LABELS, d.from)} para ${labelOf(SEVERITY_LABELS, d.to)}.`;
    case 'fix_proposed': return `${who(event)} propôs a correção${isText(d.fixSummary) ? `: ${d.fixSummary}` : '.'}`;
    case 'approved': return `${who(event)} autorizou a correção${isText(d.fixSummary) ? `: ${d.fixSummary}` : '.'}`;
    case 'rejected': return `${who(event)} recusou: de ${labelOf(STATUS_LABELS, d.from)} para ${labelOf(STATUS_LABELS, d.to)}.`;
    case 'released': return `${who(event)} marcou como liberado.`;
    case 'duplicate_marked': return `${who(event)} marcou como duplicata.`;
    case 'note': return Array.isArray(d.updated) ? 'Correção atualizada.' : isText(d.note) ? `${who(event)} anotou: ${d.note}` : 'Nota registrada.';
    default: return 'Evento registrado.';
  }
}

export function openTotal(stats) {
  const counts = stats?.openBySeverity;
  if (!isObject(counts)) return 0;
  return Object.values(counts).reduce((sum, value) => (Number.isInteger(value) && value >= 0 ? sum + value : sum), 0);
}
