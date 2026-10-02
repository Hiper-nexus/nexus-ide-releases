import { api, byId } from './account.js';
import {
  CATEGORY_LABELS, IMPACT_LABELS, PLATFORM_LABELS, SEVERITY_LABELS, STATUS_LABELS, actionRequirements, describeEvent, listQuery, nextStatuses,
  openTotal, parseDetailResponse, parseListResponse, patchBody, safeHttpsUrl,
} from './plans/bug-reports.js';

/**
 * Painel "Relatos de bugs" do /admin/. Rede e DOM aqui; as regras (transições, campos exigidos, validação das respostas)
 * ficam em plans/bug-reports.js, testadas. O texto dos relatos vem de usuários: TUDO entra por textContent, nunca como
 * HTML. A autorização de uma correção (status "approved") é um passo humano com confirmação explícita.
 */
let session = null, onDenied = () => {}, busy = false, nextCursor = null, current = null;
const number = new Intl.NumberFormat('pt-BR');
const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function el(tag, { text, className, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const when = iso => { const time = Date.parse(iso); return Number.isFinite(time) ? dateTime.format(time) : '—'; };

function setBusy(value) {
  busy = value;
  document.querySelectorAll('#bug-filter button, #bug-filter select, #bug-filter input, #refresh-bugs, #bugs-more, #bug-rows button, #bug-detail button, #bug-detail select, #bug-detail textarea, #bug-detail input').forEach(node => { node.disabled = value; });
}

function denied(error) {
  if (error?.status === 401 || error?.status === 403) { onDenied(error.message); return true; }
  return false;
}

function filters() {
  return { status: byId('bug-status').value, category: byId('bug-category').value, severity: byId('bug-severity').value, q: byId('bug-q').value };
}

function badge(text, kind) { return el('span', { text, className: `bug-badge bug-${kind}` }); }

function renderStats(stats) {
  const byStatus = stats?.byStatus ?? {};
  const items = [['Abertos', openTotal(stats)], ['Novos', byStatus.new], ['Aguardando informação', byStatus.needs_info], ['Correção proposta', byStatus.fix_proposed], ['Liberados', byStatus.released]];
  byId('bug-stats').replaceChildren(...items.map(([label, value]) => el('div', {}, [el('dt', { text: label }), el('dd', { text: number.format(Number.isInteger(value) ? value : 0) })])));
  byId('bug-stats').hidden = false;
}

function reportRow(report) {
  const title = el('strong', { text: report.title });
  const meta = el('small', { text: [report.reporterEmail, report.occurrences > 1 ? `${report.occurrences} relatos iguais` : null].filter(Boolean).join(' · ') });
  const open = el('button', { text: 'Abrir', attrs: { type: 'button', 'aria-label': `Abrir o relato: ${report.title}` } });
  open.addEventListener('click', () => { void openDetail(report.id); });
  return el('tr', {}, [
    el('td', {}, [title, meta]),
    el('td', {}, [badge(STATUS_LABELS[report.status], `status-${report.status}`)]),
    el('td', {}, [badge(SEVERITY_LABELS[report.severity], `severity-${report.severity}`)]),
    el('td', { text: CATEGORY_LABELS[report.category] }),
    el('td', { text: `${report.appVersion} · ${PLATFORM_LABELS[report.platform] ?? report.platform}` }),
    el('td', { text: when(report.createdAt) }),
    el('td', {}, [el('div', { className: 'admin-row-actions' }, [open])]),
  ]);
}

async function loadStats() {
  try { renderStats((await api('/v1/admin/bug-reports/stats'))); } catch (error) { if (!denied(error)) byId('bug-stats').hidden = true; }
}

async function loadList({ append = false } = {}) {
  setBusy(true);
  try {
    const data = parseListResponse(await api(`/v1/admin/bug-reports?${listQuery({ ...filters(), cursor: append ? nextCursor : undefined })}`));
    nextCursor = data.nextCursor;
    const rows = data.reports.map(reportRow);
    if (append) byId('bug-rows').append(...rows); else byId('bug-rows').replaceChildren(...rows);
    byId('bugs-empty').hidden = byId('bug-rows').children.length > 0;
    byId('bugs-more').hidden = nextCursor === null;
    if (!append) void loadStats();
  } catch (error) {
    if (!denied(error)) { byId('bugs-empty').textContent = error.message; byId('bugs-empty').hidden = false; }
  } finally { setBusy(false); }
}

function definition(label, value) {
  return el('div', {}, [el('dt', { text: label }), el('dd', { text: value ?? '—' })]);
}

function renderTimeline(events) {
  return el('ol', { className: 'bug-timeline' }, events.map(event => el('li', {}, [el('time', { text: when(event.createdAt), attrs: { datetime: event.createdAt } }), el('span', { text: describeEvent(event) })])));
}

function field(label, id, control, hint) {
  return el('div', { className: 'account-field' }, [el('label', { text: label, attrs: { for: id } }), control, ...(hint ? [el('p', { text: hint, className: 'account-hint' })] : [])]);
}

function select(id, options, selected) {
  const node = el('select', { attrs: { id } }, options.map(([value, text]) => el('option', { text, attrs: { value } })));
  node.value = selected;
  return node;
}

function renderActionForm(report) {
  const statusSelect = select('bug-next-status', [['', 'Manter o status atual'], ...nextStatuses(report.status).map(item => [item.status, item.label])], '');
  const severitySelect = select('bug-next-severity', [['', 'Manter a gravidade'], ...Object.entries(SEVERITY_LABELS)], '');
  const summary = el('textarea', { attrs: { id: 'bug-fix-summary', rows: '3', maxlength: '2000' } });
  summary.value = report.fixSummary ?? '';
  const prUrl = el('input', { attrs: { id: 'bug-fix-pr', type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'https://github.com/…' } });
  prUrl.value = report.fixPrUrl ?? '';
  const original = el('input', { attrs: { id: 'bug-duplicate-of', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Código completo do relato original' } });
  const note = el('textarea', { attrs: { id: 'bug-note', rows: '2', maxlength: '2000' } });
  const confirmBox = el('input', { attrs: { id: 'bug-confirm', type: 'checkbox' } });
  const confirmText = el('p', { className: 'account-hint' });
  const confirmRow = el('div', { className: 'admin-code-confirm' }, [confirmBox, el('label', { attrs: { for: 'bug-confirm' } }, [confirmText])]);
  const wrappers = {
    fix: field('Correção (o que será feito)', 'bug-fix-summary', summary, 'Obrigatória ao propor e ao autorizar. Depois de autorizada, não muda sem voltar para "Correção proposta".'),
    pr: field('Link da correção (opcional)', 'bug-fix-pr', prUrl),
    dup: field('Relato original', 'bug-duplicate-of', original, 'Cole o código completo do relato que este repete.'),
  };
  const sync = () => {
    const needs = statusSelect.value === '' ? { fixSummary: false, duplicateOf: false, confirm: null } : actionRequirements(report.status, statusSelect.value);
    wrappers.fix.hidden = !(needs.fixSummary || report.status === 'fix_proposed' || report.status === 'approved' || summary.value !== '');
    wrappers.pr.hidden = wrappers.fix.hidden;
    // O servidor trava a correção depois de autorizada: só volta a ser editável ao devolver o relato a "Correção proposta".
    const locked = ['approved', 'fixed', 'released'].includes(report.status) && statusSelect.value !== 'fix_proposed';
    summary.readOnly = locked;
    prUrl.readOnly = locked;
    wrappers.dup.hidden = !needs.duplicateOf;
    confirmRow.hidden = needs.confirm === null;
    confirmText.textContent = needs.confirm ?? '';
    if (needs.confirm === null) confirmBox.checked = false;
  };
  statusSelect.addEventListener('change', sync);
  const error = el('p', { className: 'account-message', attrs: { id: 'bug-error', role: 'alert' } });
  error.hidden = true;
  const submit = el('button', { text: 'Aplicar', className: 'button button-white', attrs: { type: 'submit' } });
  const form = el('form', { className: 'admin-code-form', attrs: { novalidate: '', 'aria-label': 'Atualizar este relato' } }, [
    field('Status', 'bug-next-status', statusSelect), field('Gravidade', 'bug-next-severity', severitySelect),
    wrappers.fix, wrappers.pr, wrappers.dup, field('Nota interna (opcional)', 'bug-note', note, 'Fica na linha do tempo, visível só para administradores.'),
    confirmRow, error, submit,
  ]);
  sync();
  form.addEventListener('submit', event => { event.preventDefault(); void submitPatch(report, { status: statusSelect.value, severity: severitySelect.value, fixSummary: summary.value, fixPrUrl: prUrl.value, duplicateOf: original.value, note: note.value }, confirmBox); });
  return form;
}

function showError(text, fieldId) {
  const error = byId('bug-error');
  error.textContent = text;
  error.hidden = false;
  if (fieldId) byId(fieldId)?.focus();
}

const FIELD_IDS = { status: 'bug-next-status', severity: 'bug-next-severity', fixSummary: 'bug-fix-summary', fixPrUrl: 'bug-fix-pr', duplicateOf: 'bug-duplicate-of', note: 'bug-note' };

async function submitPatch(report, values, confirmBox) {
  const result = patchBody({ status: report.status, severity: report.severity, fixSummary: report.fixSummary, fixPrUrl: report.fixPrUrl }, values);
  if (!result.ok) { showError(result.error, FIELD_IDS[result.field]); return; }
  if (result.body.status === 'approved' && !confirmBox.checked) { showError('Marque a confirmação para autorizar a correção.', 'bug-confirm'); return; }
  setBusy(true);
  try {
    const detail = parseDetailResponse(await api(`/v1/admin/bug-reports/${encodeURIComponent(report.id)}`, { method: 'PATCH', csrfToken: session.csrfToken, body: result.body }));
    if (detail === null) throw new Error('O serviço não retornou o relato atualizado. Atualize a página.');
    renderDetail(detail);
    void loadList();
  } catch (error) {
    if (denied(error)) return;
    showError(error.message);
    // 409: alguém mexeu antes. Recarrega o relato para o admin ver o estado real.
    if (error.status === 409) setTimeout(() => { void openDetail(report.id, { keepError: error.message }); }, 0);
  } finally { setBusy(false); }
}

function renderDetail({ report, events }) {
  current = report;
  const pr = safeHttpsUrl(report.fixPrUrl);
  const context = report.context ?? {};
  const body = [
    el('div', { className: 'admin-section-heading' }, [el('h3', { text: report.title }), el('button', { text: 'Fechar', className: 'button button-outline', attrs: { type: 'button' } })]),
    el('p', { className: 'bug-badges' }, [badge(STATUS_LABELS[report.status], `status-${report.status}`), badge(SEVERITY_LABELS[report.severity], `severity-${report.severity}`), badge(CATEGORY_LABELS[report.category], 'category'), badge(IMPACT_LABELS[report.impact] ?? report.impact, 'impact')]),
    el('dl', { className: 'admin-overview bug-facts' }, [
      definition('Versão', report.appVersion), definition('Sistema', `${PLATFORM_LABELS[report.platform] ?? report.platform} ${report.arch ?? ''} ${report.osVersion ?? ''}`.trim()),
      definition('Relatos iguais', number.format(report.occurrences ?? 1)), definition('Enviado em', when(report.createdAt)),
      definition('Quem enviou', report.reporter?.email ?? 'Conta removida'),
    ]),
    el('h4', { text: 'O que aconteceu' }), el('pre', { text: report.description, className: 'bug-text' }),
    ...(report.steps ? [el('h4', { text: 'Passos' }), el('pre', { text: report.steps, className: 'bug-text' })] : []),
    el('dl', { className: 'admin-overview bug-facts' }, [definition('CLI', context.adapter), definition('Modelo', context.model), definition('Panes abertos', context.paneCount === null || context.paneCount === undefined ? null : String(context.paneCount)),
      definition('Missão ativa', context.missionActive === null || context.missionActive === undefined ? null : context.missionActive ? 'Sim' : 'Não')]),
    ...(report.diagnostics ? [el('details', { className: 'bug-diagnostics' }, [el('summary', { text: 'Diagnóstico enviado com o relato' }), el('pre', { text: JSON.stringify(report.diagnostics, null, 2), className: 'bug-text' })])] : []),
    ...(report.fixSummary ? [el('h4', { text: 'Correção' }), el('p', { text: report.fixSummary, className: 'bug-fix' }), ...(pr ? [el('a', { text: 'Abrir a correção ↗', className: 'link-arrow', attrs: { href: pr, target: '_blank', rel: 'noopener noreferrer' } })] : report.fixPrUrl ? [el('p', { text: report.fixPrUrl, className: 'account-hint' })] : [])] : []),
    el('h4', { text: 'Linha do tempo' }), renderTimeline(events),
    el('h4', { text: 'Atualizar' }), renderActionForm(report),
  ];
  const container = byId('bug-detail');
  container.replaceChildren(...body);
  container.querySelector('.admin-section-heading button').addEventListener('click', closeDetail);
  container.hidden = false;
  container.querySelector('h3').setAttribute('tabindex', '-1');
  container.querySelector('h3').focus();
}

function closeDetail() { current = null; byId('bug-detail').hidden = true; byId('bug-detail').replaceChildren(); }

async function openDetail(id, { keepError } = {}) {
  setBusy(true);
  try {
    const detail = parseDetailResponse(await api(`/v1/admin/bug-reports/${encodeURIComponent(id)}`));
    if (detail === null) throw new Error('O serviço não retornou um relato válido. Atualize a página.');
    renderDetail(detail);
    if (keepError) showError(keepError);
  } catch (error) { if (!denied(error)) { byId('bugs-empty').textContent = error.message; byId('bugs-empty').hidden = false; } }
  finally { setBusy(false); }
}

export function resetBugs() {
  session = null; nextCursor = null; current = null;
  byId('bug-rows')?.replaceChildren();
  byId('bug-stats')?.replaceChildren();
  closeDetail();
}

export function initBugs(nextSession, options = {}) {
  session = nextSession;
  onDenied = options.onDenied ?? onDenied;
  void loadList();
}

byId('bug-filter')?.addEventListener('submit', event => { event.preventDefault(); closeDetail(); void loadList(); });
byId('refresh-bugs')?.addEventListener('click', () => { closeDetail(); void loadList(); });
byId('bugs-more')?.addEventListener('click', () => { void loadList({ append: true }); });
