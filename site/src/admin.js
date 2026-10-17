import { api, byId, message, subscriptionLabel } from './account.js';
import { initCodes, resetCodes } from './admin-codes.js';
import { initCoupons, resetCoupons } from './admin-coupons.js';
import { initBugs, resetBugs } from './admin-bugs.js';
import { icon, renderRevenueAreaChart, renderSparkline, renderStackedBar, renderWalletDonutChart } from './admin-charts.js';
import { activityView } from './plans/activity.js';
import { parseCouponsResponse } from './plans/admin-coupons.js';
import { parseCodesResponse } from './plans/license-codes.js';
import {
  DEFAULT_PERIOD, FINANCE_PERIODS, MISSING, PERIOD_LABELS, WEBHOOK_STATUS_LABELS, avatarTone, buildFallbackFinanceView,
  entryStatusLabel, filterFinanceRows, financeCsv, financeFileName, financeFilterCounts, financeReport, financeTotals,
  formatBrlCents, formatCompactBrl, formatCount, formatPct, formatShortDate, initialsOf, intervalLabel, parseFinancePayload,
  seriesTotals, sourceLabel, statementLines, statementValue,
} from './plans/admin-finance.js';
import {
  ENGAGEMENT_LABELS, accessBadge, accountsQuery, diagnose, formatMoment, liveState, momentText, parseAccountsPage,
  missionCountsLabel, relativeTime, stageOf, trialCountdown, xrayFacts,
} from './plans/admin-accounts.js';

const ACTIONS = { suspend: 'Suspender acesso', resume: 'Restaurar acesso', 'extend-trial': 'Estender teste' };
const QUICK_DAYS = [7, 15, 30];
const NUMBER = new Intl.NumberFormat('pt-BR');
const CLOCK = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' });
let activityBusy = false;
let session = null, selectedAction = null, isBusy = false, accountsCursor = null, rowCount = 0;
// Financeiro: o período vale para o relatório inteiro; filtro, busca e métrica do gráfico sobrevivem à atualização de 60 s.
let currentPeriod = DEFAULT_PERIOD, financeView = null, financeFilter = 'all', financeQuery = '', chartMode = 'mrr', financeSeq = 0;
let lastOverview = null, lastActivity = null, currentView = 'all';

/** Nó com texto sempre via textContent: nada vindo da API chega ao DOM como HTML. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconSlot(name) {
  const slot = el('span', 'adm-i');
  slot.append(icon(name));
  return slot;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(node => node.replaceChildren(icon(node.dataset.icon)));
}

const plural = (value, one, many) => (value === null ? `${many} ${MISSING.toLowerCase()}` : `${formatCount(value)} ${value === 1 ? one : many}`);

function setLive(state, text) {
  byId('live-status').dataset.state = state;
  byId('live-status-text').textContent = text;
}

// ---------- Shell: menu lateral recolhível no desktop, gaveta no celular, visões que filtram sem tirar nada do DOM ----------

const COLLAPSE_KEY = 'nexus.admin.sidebarCollapsed';
const DRAWER = window.matchMedia('(max-width: 1150px)');
const VIEW_TITLES = {
  all: 'Dashboard Executivo & Financeiro', overview: 'Visão Geral & Tempo Real', financeiro: 'Financeiro & Receita', funil: 'Funil de Trial',
  clientes: 'Clientes & Missões', cortesias: 'Licenças de Cortesia', cupons: 'Cupons de Desconto', bugs: 'Relatos de Bug',
};

function readCollapsed() { try { return localStorage.getItem(COLLAPSE_KEY) === 'true'; } catch { return false; } }
function saveCollapsed(value) { try { localStorage.setItem(COLLAPSE_KEY, String(value)); } catch { /* sem armazenamento: só não lembra */ } }

function syncSidebarUi() {
  const shell = byId('adm-shell'), drawer = DRAWER.matches;
  const collapsed = shell.dataset.sidebarCollapsed === 'true', open = shell.dataset.sidebarOpen === 'true';
  const expanded = drawer ? open : !collapsed;
  const trigger = byId('adm-sidebar-trigger'), toggle = byId('adm-sidebar-toggle');
  trigger.setAttribute('aria-expanded', String(expanded));
  trigger.setAttribute('aria-label', drawer ? (open ? 'Fechar menu lateral' : 'Abrir menu lateral') : (collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'));
  trigger.querySelector('[data-icon]').replaceChildren(icon(expanded ? 'panelClose' : 'panelOpen'));
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', drawer ? 'Fechar menu lateral' : (collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'));
  toggle.querySelector('[data-icon]').replaceChildren(icon(expanded ? 'panelClose' : 'panelOpen'));
}

function setCollapsed(value) {
  byId('adm-shell').dataset.sidebarCollapsed = String(value);
  saveCollapsed(value);
  syncSidebarUi();
}

function setDrawer(open, { restoreFocus = true } = {}) {
  byId('adm-shell').dataset.sidebarOpen = String(open);
  syncSidebarUi();
  if (open) byId('adm-sidebar').querySelector('.adm-nav-item.is-active, .adm-nav-item')?.focus();
  else if (restoreFocus && byId('adm-sidebar').contains(document.activeElement)) byId('adm-sidebar-trigger').focus();
}

function toggleSidebar() {
  if (DRAWER.matches) setDrawer(byId('adm-shell').dataset.sidebarOpen !== 'true');
  else setCollapsed(byId('adm-shell').dataset.sidebarCollapsed !== 'true');
}

/** Mostra a visão escolhida escondendo as outras por atributo; nada sai do DOM, então filtros e formulários continuam lá. */
function setView(view) {
  if (!Object.hasOwn(VIEW_TITLES, view)) view = 'all';
  currentView = view;
  document.querySelectorAll('[data-adm-section]').forEach(section => {
    if (view === 'all' || section.dataset.admSection === view) section.removeAttribute('data-view-hidden');
    else section.dataset.viewHidden = 'true';
  });
  document.querySelectorAll('.adm-nav-item[data-adm-view]').forEach(item => {
    const active = item.dataset.admView === view;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  document.querySelectorAll('.admin-subnav a[data-adm-view]').forEach(link => {
    if (link.dataset.admView === view) link.setAttribute('aria-current', 'true'); else link.removeAttribute('aria-current');
  });
  byId('adm-breadcrumb-current').textContent = VIEW_TITLES[view];
  if (view === 'financeiro' || view === 'all') requestAnimationFrame(renderChart);
}

function goToView(view, target) {
  setView(view);
  if (DRAWER.matches) setDrawer(false, { restoreFocus: false });
  const destination = view === 'all' ? byId('adm-top') : target;
  destination?.scrollIntoView({ block: 'start' });
  destination?.focus?.({ preventScroll: true });
}

function initShell() {
  hydrateIcons();
  byId('adm-shell').dataset.sidebarCollapsed = String(readCollapsed());
  syncSidebarUi();
  byId('adm-sidebar-trigger').addEventListener('click', toggleSidebar);
  byId('adm-sidebar-toggle').addEventListener('click', toggleSidebar);
  byId('adm-sidebar-backdrop').addEventListener('click', () => setDrawer(false));
  DRAWER.addEventListener('change', () => { byId('adm-shell').dataset.sidebarOpen = 'false'; syncSidebarUi(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && DRAWER.matches && byId('adm-shell').dataset.sidebarOpen === 'true') setDrawer(false);
  });
  document.querySelectorAll('[data-adm-view]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    const id = link.getAttribute('href')?.slice(1);
    goToView(link.dataset.admView, id ? byId(id) : null);
  }));
  document.querySelectorAll('[data-adm-section]').forEach(section => { section.tabIndex = -1; });
}

// ---------- Segurança da sessão ----------

function denyAccess(text) {
  session = null;
  resetCodes();
  resetCoupons();
  resetBugs();
  resetFinance();
  selectedAction = null;
  lastOverview = null;
  lastActivity = null;
  byId('admin-content').hidden = true;
  byId('admin-denied').hidden = false;
  byId('overview').replaceChildren();
  byId('activity-overview').replaceChildren();
  byId('funnel-steps').replaceChildren();
  byId('admin-activity-note').textContent = 'Entre com uma conta administrativa para consultar.';
  byId('accounts-body').replaceChildren();
  byId('accounts-count').textContent = '';
  accountsCursor = null;
  rowCount = 0;
  byId('accounts-more').hidden = true;
  byId('admin-action-panel').hidden = true;
  byId('action-account').textContent = '';
  setLive('idle', 'Sem permissão');
  message('admin-message', text, 'error');
}

function setBusy(value) {
  isBusy = value;
  document.querySelectorAll('#filter-form button, #filter-form select, #filter-form input, #accounts-more, .admin-row-actions button, .quick-filter, #overview .kpi-card, #admin-action-form button').forEach(button => { button.disabled = value; });
}

/** Marca como pressionados o cartão e o atalho que correspondem aos filtros atuais. */
function syncFilterUi() {
  const status = byId('status-filter').value, engagement = byId('engagement-filter').value;
  document.querySelectorAll('#overview .kpi-card').forEach(card => card.setAttribute('aria-pressed', String(card.dataset.status === status && engagement === 'all')));
  document.querySelectorAll('.quick-filter').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.status === status && button.dataset.engagement === engagement)));
}

function applyFilters(status, engagement) {
  if (isBusy || !session) return;
  byId('status-filter').value = status;
  byId('engagement-filter').value = engagement;
  closeAction();
  // O cartão e o atalho levam à lista: se a visão atual a esconde, troca para a visão de clientes antes de rolar.
  if (currentView !== 'all' && currentView !== 'clientes') setView('clientes');
  void loadAccounts();
  byId('clientes').scrollIntoView({ block: 'start' });
}

// ---------- Cartões de KPI (anatomia stat-card do @shadcnuikit: ícone, rótulo, selo, valor, legenda e barra fina) ----------

/** Monta um cartão. Num <dl> o cabeçalho é <dt> e o miolo <dd>; num botão, <span>. */
function fillKpi(card, { iconName, label, value, hint, ratio = null, badge = null, badgeTone = 'muted', definition = false }) {
  const head = el(definition ? 'dt' : 'span', 'kpi-head'), body = el(definition ? 'dd' : 'span', 'kpi-body');
  head.append(iconSlot(iconName), el('span', 'kpi-label', label));
  if (badge) { const chip = el('span', 'adm-delta-badge', badge); chip.dataset.tone = badgeTone; head.append(chip); }
  body.append(el('span', 'kpi-value', value));
  if (hint) body.append(el('span', 'kpi-hint', hint));
  if (ratio !== null) {
    const meter = el('span', 'kpi-meter'), fill = el('span', 'kpi-meter-fill');
    meter.setAttribute('aria-hidden', 'true');
    fill.style.setProperty('--ratio', String(Math.max(0, Math.min(1, ratio))));
    meter.append(fill);
    body.append(meter);
  }
  card.append(head, body);
  return card;
}

const pctOf = (value, total) => (total > 0 ? Math.round((value / total) * 100) : 0);

const OVERVIEW = [['accounts', 'Total de contas', 'all', 'users'], ['trial', 'Em teste', 'trial', 'hourglass'], ['active', 'Assinantes ativos', 'active', 'check'], ['expired', 'Expirados', 'expired', 'calendarX'], ['suspended', 'Suspensos', 'suspended', 'ban']];
function renderOverview(data) {
  if (!OVERVIEW.every(([key]) => Number.isInteger(data[key]) && data[key] >= 0)) throw new Error('O serviço não retornou um resumo válido. Atualize novamente.');
  lastOverview = data;
  byId('overview').replaceChildren(...OVERVIEW.map(([key, label, status, iconName]) => {
    const card = el('button', 'kpi-card');
    card.type = 'button';
    card.dataset.status = status;
    card.dataset.tone = key;
    card.addEventListener('click', () => applyFilters(status, 'all'));
    const share = pctOf(data[key], data.accounts);
    return fillKpi(card, key === 'accounts'
      ? { iconName, label, value: NUMBER.format(data[key]), hint: 'todas as situações', ratio: data.accounts > 0 ? 1 : 0 }
      : { iconName, label, value: NUMBER.format(data[key]), hint: 'do total de contas', ratio: data.accounts > 0 ? data[key] / data.accounts : 0, badge: `${share}%`, badgeTone: key === 'active' ? 'ok' : key === 'trial' ? 'warn' : key === 'suspended' ? 'bad' : 'muted' });
  }));
  byId('overview').hidden = false;
  byId('overview-card').dataset.state = 'ready';
  syncFilterUi();
}

function renderFunnel(funnel) {
  const steps = byId('funnel-steps');
  byId('funnel-empty').hidden = funnel !== null;
  if (funnel === null) { steps.replaceChildren(); byId('funnel-summary').textContent = 'Funil indisponível agora.'; return; }
  byId('funnel-summary').textContent = funnel.total === 0 ? 'Nenhum cliente em teste ativo agora.' : `${NUMBER.format(funnel.total)} em teste ativo. ${funnel.live}.`;
  steps.replaceChildren(...funnel.steps.map((step, index) => {
    const item = el('li', 'funnel-step');
    item.dataset.step = step.key;
    const bar = el('span', 'funnel-bar'), fill = el('span', 'funnel-fill');
    fill.style.setProperty('--ratio', String(step.ratio));
    bar.append(fill);
    const label = el('span', 'funnel-label');
    label.append(el('span', 'funnel-index', String(index + 1)), document.createTextNode(step.label));
    item.append(label, el('span', 'funnel-count', NUMBER.format(step.value)), el('span', 'funnel-percent', `${step.percent}%`), bar);
    return item;
  }));
}

const ACTIVITY_ICONS = {
  onlineNow: 'radio', missionsRunningNow: 'play', missionsTotalCompleted: 'checks', usedToday: 'zap', used7d: 'calendar',
  startedAgents: 'bot', completedMission: 'flag', returned: 'repeat', paidAccounts: 'card', trackedAccounts: 'gauge',
};
// Métricas que contam contas: a barra fina mostra a fração das contas com medição.
const SHARE_OF_TRACKED = new Set(['onlineNow', 'usedToday', 'used7d', 'startedAgents', 'completedMission', 'returned']);

async function refreshActivity() {
  if (!session || activityBusy || document.hidden) return;
  activityBusy = true;
  setLive('busy', 'Consultando sinais do app…');
  if (!byId('activity-overview').children.length) byId('activity-card').dataset.state = 'loading';
  try {
    const data = await api('/v1/admin/activity');
    const view = activityView(data);
    if (!view) throw new Error('O serviço não retornou métricas válidas.');
    if (!session) return;
    lastActivity = data;
    const tracked = view.metrics.find(row => row.key === 'trackedAccounts').value ?? 0;
    byId('activity-overview').replaceChildren(...view.metrics.map(({ key, label, hint, value }) => {
      const card = el('div', 'kpi-card');
      card.dataset.metric = key;
      const live = value > 0 && (key === 'onlineNow' || key === 'missionsRunningNow');
      if (live) card.dataset.live = 'true';
      const share = SHARE_OF_TRACKED.has(key) && value !== null && tracked > 0;
      return fillKpi(card, {
        iconName: ACTIVITY_ICONS[key] ?? 'activity', label, value: value === null ? MISSING : NUMBER.format(value), hint, definition: true,
        ratio: share ? value / tracked : null, badge: live ? 'Ao vivo' : share ? `${pctOf(value, tracked)}%` : null, badgeTone: live ? 'ok' : 'muted',
      });
    }));
    renderFunnel(view.funnel);
    byId('admin-activity-note').textContent = view.note;
    byId('activity-card').dataset.state = 'ready';
    const online = view.metrics.find(row => row.key === 'onlineNow').value;
    setLive('ok', `Ao vivo: ${NUMBER.format(online)} online agora, atualizado às ${CLOCK.format(new Date())}`);
  } catch (error) {
    byId('activity-overview').replaceChildren();
    byId('activity-card').dataset.state = 'error';
    renderFunnel(null);
    byId('admin-activity-note').textContent = `Medição indisponível: ${error.message} Nenhum número foi estimado.`;
    setLive('error', 'Medição indisponível');
    if (error.status === 401 || error.status === 403) denyAccess(error.message);
  } finally {
    activityBusy = false;
    if (session) void loadFinance();
  }
}

// ---------- Clientes ----------

function timeLine(label, value, now) {
  const line = el('span', 'client-line');
  line.append(el('span', 'client-line-label', label));
  const formatted = formatMoment(value);
  if (formatted === null) { line.append(el('span', 'client-muted', 'Sem registro')); return line; }
  const time = el('time', '', formatted);
  time.dateTime = value;
  line.append(time, el('small', '', relativeTime(value, now)));
  return line;
}

function badge(text, tone) {
  const node = el('span', 'status-badge', text);
  node.dataset.tone = tone;
  return node;
}

function cell(label, ...children) {
  const node = el('td');
  node.dataset.label = label;
  node.append(...children);
  return node;
}

/** Avatar de iniciais + nome e e-mail. As iniciais são texto; a cor vem do id, estável entre as tabelas. */
function identity(seed, name, email, fallbackName) {
  const box = el('div', 'adm-identity'), avatar = el('span', 'adm-avatar', initialsOf(name, email)), text = el('div', 'adm-identity-text');
  avatar.dataset.tone = String(avatarTone(seed));
  avatar.setAttribute('aria-hidden', 'true');
  text.append(el('strong', '', name || fallbackName), el('small', '', email || MISSING));
  box.append(avatar, text);
  return box;
}

function xrayRow(account, now, id) {
  const row = el('tr', 'client-xray-row'), body = el('td', 'client-xray');
  row.id = id;
  row.hidden = true;
  body.colSpan = 6;
  const facts = el('dl', 'client-xray-facts');
  for (const [label, text] of xrayFacts(account, now)) {
    const item = el('div', 'client-xray-fact');
    item.append(el('dt', '', label), el('dd', text === 'Sem registro' ? 'client-muted' : '', text));
    facts.append(item);
  }
  body.append(el('p', 'client-xray-diagnosis', diagnose(account)));
  if (account.suspendedAt) body.append(el('p', 'client-xray-reason', `Suspenso: ${account.suspensionReason || 'sem motivo registrado'}`));
  body.append(facts);
  row.append(body);
  return row;
}

function accountRows(account, now) {
  const row = el('tr', 'admin-account-row');
  const detailsId = `xray-${account.id.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const who = cell('Cliente', identity(account.id, account.name, account.email, 'Sem nome informado'));
  const tags = el('span', 'client-tags');
  if (account.role === 'admin') tags.append(badge('admin', 'info'));
  const live = liveState(account);
  if (live) tags.append(badge(live.label, live.tone));
  if (tags.children.length) who.append(tags);

  const access = accessBadge(account.access), countdown = trialCountdown(account, now);
  const accessCell = cell('Acesso e teste', badge(access.label, access.tone), el('small', '', subscriptionLabel(account.subscriptionStatus)));
  if (countdown) accessCell.append(el('small', 'client-countdown', countdown));

  const stage = stageOf(account);
  const usage = cell('Uso do sistema', badge(ENGAGEMENT_LABELS[stage], stage === 'mission_active' ? 'ok' : stage === 'never_seen' ? 'muted' : 'info'),
    el('small', '', account.lastActiveAt ? `Último uso ${relativeTime(account.lastActiveAt, now)}` : 'Sem uso de agentes'),
    el('small', 'client-nums', `${account.activeDays7d ?? 0}d/7d · ${account.activeDays30d ?? 0}d/30d`));

  // Cobertura pré-0012 fica declarada na nota da seção: o UPDATE da 0012 não gravou marcador por linha.
  const missions = cell('Missões', el('strong', 'client-nums', missionCountsLabel(account)),
    el('small', '', account.lastMissionAt ? `Última ${relativeTime(account.lastMissionAt, now)}` : 'Nenhuma missão ainda'));
  if (account.missionRunningNow === true) missions.append(badge('Em execução agora', 'ok'));

  const group = el('div', 'admin-row-actions');
  const details = el('button', 'client-xray-toggle', 'Detalhes');
  details.type = 'button';
  details.setAttribute('aria-expanded', 'false');
  details.setAttribute('aria-controls', detailsId);
  details.setAttribute('aria-label', `Detalhes de ${account.email}`);
  const xray = xrayRow(account, now, detailsId);
  details.addEventListener('click', () => {
    const open = xray.hidden;
    xray.hidden = !open;
    details.setAttribute('aria-expanded', String(open));
    row.dataset.open = String(open);
  });
  group.append(details);
  const addAction = (action, label, days) => {
    const button = el('button', '', label);
    button.type = 'button';
    button.setAttribute('aria-label', `${ACTIONS[action]}${days ? ` em ${days} dias` : ''} de ${account.email}`);
    button.addEventListener('click', () => openAction(account, action, days));
    group.append(button);
  };
  for (const days of QUICK_DAYS) addAction('extend-trial', `+${days}d`, days);
  addAction(account.access === 'suspended' ? 'resume' : 'suspend', account.access === 'suspended' ? 'Reativar' : 'Suspender');
  row.append(who, accessCell, cell('Último login e app', timeLine('Login web', account.lastSeenAt, now), timeLine('App', account.lastAppSeenAt, now)), usage, missions, cell('Ações', group));
  return [row, xray];
}

function renderAccounts(data, { append }) {
  const page = parseAccountsPage(data);
  if (!page) throw new Error('O serviço não retornou uma lista válida. Atualize novamente.');
  const now = Date.now(), rows = page.accounts.flatMap(account => accountRows(account, now));
  if (append) byId('accounts-body').append(...rows);
  else byId('accounts-body').replaceChildren(...rows);
  rowCount = append ? rowCount + page.accounts.length : page.accounts.length;
  accountsCursor = page.nextCursor;
  byId('accounts-empty').hidden = rowCount > 0;
  byId('accounts-more').hidden = page.nextCursor === null;
  byId('accounts-count').textContent = rowCount === 0 ? '' : `Mostrando ${NUMBER.format(rowCount)} ${rowCount === 1 ? 'cliente' : 'clientes'}${page.nextCursor ? ', há mais' : ''}.`;
}

async function loadAccounts({ append = false } = {}) {
  if (isBusy || !session) return false;
  if (append && !accountsCursor) return false;
  setBusy(true);
  if (!append) {
    accountsCursor = null;
    rowCount = 0;
    byId('accounts-body').replaceChildren();
    byId('accounts-count').textContent = '';
    byId('overview').hidden = true;
    byId('overview-card').dataset.state = 'loading';
  }
  syncFilterUi();
  byId('accounts-empty').hidden = true;
  byId('accounts-more').hidden = true;
  message('admin-message', append ? 'Carregando mais clientes…' : 'Consultando clientes, testes e missões…');
  const listCall = api(`/v1/admin/accounts?${accountsQuery({ status: byId('status-filter').value, engagement: byId('engagement-filter').value, email: byId('email-filter').value, cursor: append ? accountsCursor : undefined })}`);
  const results = await Promise.allSettled(append ? [listCall] : [api('/v1/admin/overview'), listCall]);
  const errors = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index], isOverview = !append && index === 0;
    if (result.status === 'rejected') { errors.push(result.reason); if (isOverview) byId('overview-card').dataset.state = 'error'; continue; }
    try { if (isOverview) renderOverview(result.value); else renderAccounts(result.value, { append }); }
    catch (error) { errors.push(error); if (isOverview) byId('overview-card').dataset.state = 'error'; }
  }
  setBusy(false);
  if (!append) void refreshActivity();
  const permissionError = errors.find(error => error.status === 401 || error.status === 403);
  if (permissionError) { denyAccess(permissionError.message); return false; }
  if (errors.length && append && accountsCursor) byId('accounts-more').hidden = false;
  message('admin-message', errors.length ? errors[0].message : 'Dados atualizados pelo servidor.', errors.length ? 'error' : '');
  return errors.length === 0;
}

function closeAction() {
  selectedAction = null;
  const wasOpen = !byId('admin-action-panel').hidden;
  byId('admin-action-panel').hidden = true;
  byId('action-error').hidden = true;
  if (wasOpen) byId('status-filter').focus();
}

function openAction(account, action, days = 7) {
  if (isBusy || !Object.hasOwn(ACTIONS, action)) return;
  selectedAction = { id: account.id, action };
  byId('action-title').textContent = ACTIONS[action] + '.';
  byId('action-account').textContent = account.email;
  byId('reason-field').hidden = action !== 'suspend';
  byId('suspension-note').hidden = action !== 'suspend';
  byId('days-field').hidden = action !== 'extend-trial';
  byId('suspension-reason').required = action === 'suspend';
  byId('trial-days').required = action === 'extend-trial';
  byId('suspension-reason').disabled = action !== 'suspend';
  byId('trial-days').disabled = action !== 'extend-trial';
  byId('suspension-reason').value = '';
  byId('trial-days').value = String(days);
  byId('confirm-admin-action').textContent = ACTIONS[action];
  byId('action-error').hidden = true;
  byId('admin-action-panel').hidden = false;
  byId('admin-action-panel').focus();
  byId('admin-action-panel').scrollIntoView({ block: 'nearest' });
}

function actionBody(action) {
  if (action === 'suspend') {
    const reason = byId('suspension-reason').value.trim();
    if (!reason || reason.length > 500) throw new Error('Informe um motivo com até 500 caracteres.');
    return { reason };
  }
  if (action === 'extend-trial') {
    const days = Number(byId('trial-days').value);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('Informe um número inteiro entre 1 e 30 dias.');
    return { days };
  }
  return {};
}

async function submitAction(event) {
  event.preventDefault();
  if (isBusy || !session || !selectedAction) return;
  byId('action-error').hidden = true;
  let body;
  try { body = actionBody(selectedAction.action); }
  catch (error) { byId('action-error').textContent = error.message; byId('action-error').hidden = false; return; }
  const { id, action } = selectedAction;
  setBusy(true);
  try {
    await api(`/v1/admin/accounts/${encodeURIComponent(id)}/${action}`, { method: 'POST', csrfToken: session.csrfToken, body });
    closeAction();
    setBusy(false);
    const refreshed = await loadAccounts();
    if (session && refreshed) message('admin-message', `${ACTIONS[action]}: ação confirmada pelo servidor.`, 'success');
  } catch (error) {
    if (error.status === 401 || error.status === 403) denyAccess(error.message);
    else { byId('action-error').textContent = error.message; byId('action-error').hidden = false; }
  } finally { setBusy(false); }
}

// ---------- Financeiro (GET /v1/admin/finance), com fallback honesto quando o endpoint não responde ----------

/** Cupons e códigos para o fallback. ponytail: consulta de novo as listas que admin-coupons/admin-codes já pediram;
 * só acontece enquanto /v1/admin/finance não responde. Se virar rotina, expor o último resultado daqueles módulos. */
async function fallbackLists() {
  const [coupons, codes] = await Promise.allSettled([api('/v1/admin/coupons'), api('/v1/admin/license-codes')]);
  const safe = (result, parse) => { try { return result.status === 'fulfilled' ? parse(result.value) : null; } catch { return null; } };
  return { coupons: safe(coupons, parseCouponsResponse), codes: safe(codes, parseCodesResponse) };
}

async function loadFinance() {
  if (!session) return;
  const seq = ++financeSeq, period = currentPeriod;
  if (!financeView) byId('financeiro').dataset.state = 'loading';
  let view = null, reason = '';
  try {
    view = parseFinancePayload(await api(`/v1/admin/finance?period=${encodeURIComponent(period)}`));
    if (!view) reason = 'resposta fora do contrato';
  } catch (error) {
    if (error.status === 401 || error.status === 403) { if (seq === financeSeq) denyAccess(error.message); return; }
    reason = error.status ? `HTTP ${error.status}` : 'sem conexão';
  }
  if (!view) view = buildFallbackFinanceView(lastOverview, lastActivity, { ...(await fallbackLists()), period, reason });
  if (seq !== financeSeq || !session) return;
  financeView = view;
  renderFinance();
}

function setSlot(card, slot, text) { card.querySelector(`[data-slot="${slot}"]`).textContent = text; }

/** Barra fina no rodapé do cartão: a fração do denominador que o valor representa. */
function renderShare(slot, value, total, suffix = 'do bruto contratado') {
  if (!(value >= 0) || !(total > 0)) { slot.replaceChildren(); return; }
  const meter = el('span', 'kpi-meter'), fill = el('span', 'kpi-meter-fill');
  meter.setAttribute('aria-hidden', 'true');
  fill.style.setProperty('--ratio', String(Math.min(1, value / total)));
  meter.append(fill);
  slot.replaceChildren(meter, el('span', 'adm-stat-share', `${formatPct((value / total) * 100)} ${suffix}`));
}

function renderFinanceKpis(view) {
  const { kpis, report, period, series } = view, estimate = view.source === 'fallback' ? ' · estimativa de catálogo' : '';
  const card = key => document.querySelector(`[data-finance-kpi="${key}"]`);
  const slot = key => card(key).querySelector('[data-slot="spark"]');
  const spark = (key, field) => renderSparkline(slot(key), series.map(point => point[field]));
  setSlot(card('mrr'), 'value', formatBrlCents(kpis.mrrCents));
  setSlot(card('mrr'), 'badge', `ARR: ${formatBrlCents(kpis.arrCents)}/ano`);
  setSlot(card('mrr'), 'caption', `${plural(kpis.paidActiveSubscriptions, 'assinatura paga ativa', 'assinaturas pagas ativas')} · ${plural(kpis.paidActiveSeats, 'assento', 'assentos')}${estimate}`);
  spark('mrr', 'cumulativeNewMrrCents');
  setSlot(card('net'), 'value', formatBrlCents(kpis.netCommitmentCents));
  setSlot(card('net'), 'badge', report.invoicePaidEventsInPeriod === null ? `Webhooks invoice.paid: ${MISSING.toLowerCase()}` : `${plural(report.invoicePaidEventsInPeriod, 'webhook invoice.paid', 'webhooks invoice.paid')} (${period.key})`);
  setSlot(card('net'), 'caption', `Bruto dos ciclos ativos: ${formatBrlCents(kpis.grossCommitmentCents)}`);
  renderShare(slot('net'), kpis.netCommitmentCents, kpis.grossCommitmentCents);
  setSlot(card('risk'), 'value', formatBrlCents(kpis.pastDueAtRiskCents));
  const risk = card('risk').querySelector('[data-slot="badge"]');
  risk.textContent = kpis.pastDueSubscriptions === null && kpis.canceledSubscriptions === null ? `Atraso e cancelamentos: ${MISSING.toLowerCase()}`
    : `${plural(kpis.pastDueSubscriptions, 'em atraso', 'em atraso')} · ${plural(kpis.canceledSubscriptions, 'cancelada', 'canceladas')}`;
  risk.dataset.tone = kpis.pastDueSubscriptions > 0 ? 'warn' : kpis.pastDueSubscriptions === 0 ? 'ok' : 'muted';
  setSlot(card('risk'), 'caption', 'Carência de 7 dias antes de perder o acesso Pro');
  const riskBook = kpis.grossCommitmentCents !== null && kpis.pastDueAtRiskCents !== null ? kpis.grossCommitmentCents + kpis.pastDueAtRiskCents : null;
  renderShare(slot('risk'), kpis.pastDueAtRiskCents, riskBook, 'do total ativo + em atraso');
  setSlot(card('discounts'), 'value', formatBrlCents(kpis.estimatedDiscountCents));
  setSlot(card('discounts'), 'badge', `${plural(kpis.couponRedemptionsTotal, 'cupom', 'cupons')} · ${plural(kpis.codeGrantActive, 'cortesia', 'cortesias')}`);
  setSlot(card('discounts'), 'caption', `Conversão Trial → Pago: ${formatPct(kpis.trialConversionRatePct)}`);
  renderShare(slot('discounts'), kpis.estimatedDiscountCents, kpis.grossCommitmentCents);
}

// A série do servidor é diária e só tem fluxos: a área do MRR é o MRR novo acumulado no período, não o MRR total.
const CHART_MODES = {
  mrr: { area: 'cumulativeNewMrrCents', bar: 'estimatedNewMrrCents', areaLabel: 'MRR novo acumulado', barLabel: 'MRR novo no dia', money: true,
    foot: totals => `MRR novo no período: ${formatBrlCents(totals.estimatedNewMrrCents)} em ${plural(totals.newPaidSubscriptions, 'assinatura paga nova', 'assinaturas pagas novas')}.` },
  subs: { area: 'activeAccounts', bar: 'newSubscriptions', areaLabel: 'Contas com uso no dia', barLabel: 'Assinaturas novas', money: false,
    foot: totals => `${plural(totals.newSubscriptions, 'assinatura nova', 'assinaturas novas')} e ${plural(totals.newAccounts, 'conta criada', 'contas criadas')} no período.` },
  webhooks: { area: 'invoicePaidEvents', bar: 'webhookEvents', areaLabel: 'invoice.paid', barLabel: 'Eventos Stripe', money: false,
    foot: totals => `${plural(totals.webhookEvents, 'evento da Stripe', 'eventos da Stripe')}, ${plural(totals.invoicePaidEvents, 'pagamento confirmado', 'pagamentos confirmados')} no período.` },
};

function renderChart() {
  const container = byId('finance-revenue-chart');
  if (!financeView || !container || container.closest('[data-view-hidden]')) return;
  const mode = CHART_MODES[chartMode], view = financeView;
  const legend = byId('finance-chart-legend');
  const swatch = (kind, text) => { const item = el('span', `adm-legend-item is-${kind}`); item.append(el('span', 'adm-legend-swatch'), document.createTextNode(text)); return item; };
  legend.replaceChildren(swatch('area', mode.areaLabel), swatch('bar', mode.barLabel));
  const format = (value, axis) => (mode.money ? (axis ? formatCompactBrl(Math.round(value)) : formatBrlCents(value)) : NUMBER.format(Math.round(value)));
  renderRevenueAreaChart(container, {
    points: view.series.map(point => ({ label: point.label, area: point[mode.area], bar: point[mode.bar] })),
    areaLabel: mode.areaLabel, barLabel: mode.barLabel, format,
    emptyMessage: view.source === 'fallback' ? 'A série histórica chega com o relatório financeiro do servidor.' : 'Nenhum ponto registrado neste período.',
  }, { height: container.clientWidth < 420 ? 200 : 240 });
  byId('finance-revenue-trend').textContent = view.series.length ? mode.foot(seriesTotals(view.series)) : '';
}

function renderIncomeSources(view) {
  byId('finance-income-total').textContent = formatBrlCents(view.kpis.mrrCents);
  renderStackedBar(byId('finance-income-bar'), view.intervals, { label: 'MRR por ciclo' });
  const known = view.intervals.some(row => row.subscriptions !== null);
  const items = view.intervals.map(row => {
    const item = el('li', 'adm-source-row'), dot = el('span', 'adm-dot');
    dot.style.setProperty('--seg', row.color);
    const name = el('span', 'adm-source-name');
    name.append(dot, el('strong', '', row.label), el('small', '', formatBrlCents(row.priceCents)));
    const numbers = el('span', 'adm-source-numbers');
    numbers.append(el('strong', '', formatBrlCents(row.mrrCents)), el('small', '', known ? `${plural(row.subscriptions, 'assinatura', 'assinaturas')} · ${Math.round(row.share * 100)}%` : `cobrança a cada ${row.months === 1 ? 'mês' : `${row.months} meses`}`));
    item.append(name, numbers);
    return item;
  });
  if (!known) items.push(el('li', 'adm-source-note', 'Preços do catálogo. A distribuição por ciclo chega com o relatório do servidor.'));
  byId('finance-income-list').replaceChildren(...items);
}

function renderWallet(view) {
  renderWalletDonutChart(byId('finance-wallet-donut'), { segments: view.wallet.segments, total: view.wallet.total, centerLabel: 'contas' });
  byId('finance-wallet-legend').replaceChildren(...view.wallet.segments.map(segment => {
    const item = el('li', 'adm-legend-chip'), dot = el('span', 'adm-dot');
    dot.style.setProperty('--seg', segment.color);
    item.append(dot, el('span', 'adm-legend-label', segment.label), el('strong', '', formatCount(segment.value)), el('small', '', segment.value === null ? '' : `${Math.round(segment.share * 100)}%`));
    return item;
  }));
}

const ENTRY_TONES = { active: 'ok', trialing: 'ok', past_due: 'warn', unpaid: 'bad', canceled: 'bad', incomplete: 'muted', incomplete_expired: 'bad', paused: 'muted' };
const WEBHOOK_TONES = { processed: 'ok', ignored: 'muted', pending: 'warn', failed: 'bad' };
const ENTRY_COLUMNS = ['Cliente', 'Origem / Ciclo', 'Status', 'Bruto / Cupom', 'Líquido / MRR', 'Vigência / Atualização'];
const WEBHOOK_COLUMNS = ['Evento', 'Tipo', 'Cliente', 'Status', 'Recebido em'];

function cycleBadge(entry, view) {
  const chip = el('span', 'adm-cycle-badge', entry.intervalLabel ?? (entry.interval ? intervalLabel(entry.interval) : entry.kind === 'courtesy' ? 'Cortesia' : 'Sem ciclo'));
  const color = view.intervals.find(row => row.id === entry.interval)?.color;
  if (color) chip.style.setProperty('--seg', color);
  return chip;
}

function entryRow(entry, view) {
  const row = el('tr');
  // Cortesia não tem cobrança: zero ali não é receita perdida nem dado faltando.
  const amount = cents => (entry.kind === 'courtesy' && !cents ? 'Sem cobrança' : formatBrlCents(cents));
  const origin = cell('Origem / Ciclo', cycleBadge(entry, view), el('small', '', sourceLabel(entry.source)));
  const gross = cell('Bruto / Cupom', el('strong', 'client-nums', amount(entry.grossCents)));
  if (entry.couponCode) { const coupon = el('span', 'adm-coupon-chip', entry.couponCode); gross.append(coupon); }
  if (entry.discountCents > 0) gross.append(el('small', '', `Desconto ${formatBrlCents(entry.discountCents)}`));
  const net = el('strong', 'client-nums adm-net', amount(entry.netCents));
  net.dataset.tone = entry.kind === 'past_due' ? 'warn' : entry.kind === 'paid' ? 'ok' : 'muted';
  row.append(
    cell('Cliente', identity(entry.accountId ?? entry.id, entry.name, entry.email, 'Sem nome informado')), origin,
    cell('Status', badge(entryStatusLabel(entry.status, entry.lapsed), entry.lapsed ? 'muted' : ENTRY_TONES[entry.status] ?? 'muted')), gross,
    cell('Líquido / MRR', net, el('small', '', entry.kind === 'courtesy' && !entry.mrrCents ? 'Sem MRR' : `MRR ${formatBrlCents(entry.mrrCents)}`)),
    cell('Vigência / Atualização', el('span', 'client-nums', entry.currentPeriodEnd ? `Até ${formatShortDate(entry.currentPeriodEnd)}` : 'Sem vigência'), el('small', '', entry.updatedAt ? `Atualizado ${formatShortDate(entry.updatedAt)}` : MISSING)),
  );
  return row;
}

function webhookRow(event) {
  const row = el('tr');
  row.append(
    cell('Evento', el('span', 'adm-mono', event.eventId), ...(event.subscriptionId ? [el('small', 'adm-mono', event.subscriptionId)] : [])),
    cell('Tipo', el('span', 'adm-event-type', event.type)),
    cell('Cliente', el('span', '', event.customerEmail ?? MISSING)),
    cell('Status', badge(WEBHOOK_STATUS_LABELS[event.status], WEBHOOK_TONES[event.status]), ...(event.ignoredReason ? [el('small', '', event.ignoredReason)] : [])),
    cell('Recebido em', el('span', 'client-nums', formatMoment(event.createdAt) ?? MISSING), el('small', '', relativeTime(event.createdAt))),
  );
  return row;
}

function renderFinanceTable() {
  const view = financeView;
  if (!view) return;
  const counts = financeFilterCounts(view);
  document.querySelectorAll('#finance-table-tabs [data-fin-filter]').forEach(tab => {
    const active = tab.dataset.finFilter === financeFilter;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.querySelector('.adm-tab-count').textContent = NUMBER.format(counts[tab.dataset.finFilter]);
    if (active) byId('finance-table-panel').setAttribute('aria-labelledby', tab.id);
  });
  const webhooks = financeFilter === 'webhooks', rows = filterFinanceRows(view, { filter: financeFilter, query: financeQuery });
  const head = el('tr');
  head.append(...(webhooks ? WEBHOOK_COLUMNS : ENTRY_COLUMNS).map(label => { const th = el('th', '', label); th.scope = 'col'; return th; }));
  byId('finance-table-head').replaceChildren(head);
  byId('finance-table-body').replaceChildren(...rows.map(row => (webhooks ? webhookRow(row) : entryRow(row, view))));
  byId('finance-table-panel').hidden = rows.length === 0;
  byId('finance-empty').hidden = rows.length > 0;
  const total = webhooks ? counts.webhooks : counts.all;
  byId('finance-empty-text').textContent = view.source === 'fallback' ? 'As assinaturas e os eventos da Stripe aparecem aqui quando o servidor publicar o relatório financeiro.'
    : financeQuery.trim() ? `Nada encontrado para “${financeQuery.trim()}”.` : total === 0 ? (webhooks ? 'Nenhum evento da Stripe registrado ainda.' : 'Nenhuma assinatura registrada ainda.') : 'Nenhuma linha com este filtro.';
  byId('finance-table-count').textContent = `${NUMBER.format(rows.length)} de ${NUMBER.format(total)} ${webhooks ? 'eventos' : 'linhas'}`;
  if (rows.length === 0) byId('finance-table-footer').textContent = '';
  else if (webhooks) byId('finance-table-footer').textContent = `${plural(rows.length, 'evento listado', 'eventos listados')} · mais recentes primeiro`;
  else {
    const sum = financeTotals(rows);
    byId('finance-table-footer').textContent = `Total listado: ${formatBrlCents(sum.netCents)} · MRR: ${formatBrlCents(sum.mrrCents)}`;
  }
}

function renderStatement(view) {
  byId('finance-statement').replaceChildren(...statementLines(view).map(line => {
    const row = el('div', 'adm-statement-row'), term = el('dt');
    row.dataset.kind = line.kind;
    if (line.sign) term.append(el('span', 'adm-sign', line.sign));
    term.append(document.createTextNode(line.label));
    row.append(term, el('dd', 'client-nums', statementValue(line)));
    return row;
  }));
  byId('finance-basis-note').textContent = view.report.basisNote;
}

function renderFinance() {
  const view = financeView;
  const section = byId('financeiro');
  section.dataset.state = view.source === 'server' ? 'ready' : 'fallback';
  const source = byId('finance-source');
  source.textContent = view.source === 'server' ? `Servidor · ${view.period.label}` : 'Estimativa local';
  source.dataset.tone = view.source === 'server' ? 'ok' : 'warn';
  byId('finance-notice').hidden = !view.notice;
  byId('finance-notice').textContent = view.notice ?? '';
  byId('finance-report-period').textContent = view.period.label;
  renderFinanceKpis(view);
  renderIncomeSources(view);
  renderWallet(view);
  renderFinanceTable();
  renderStatement(view);
  renderChart();
}

function resetFinance() {
  financeSeq++;
  financeView = null;
  byId('financeiro').dataset.state = 'loading';
  document.querySelectorAll('[data-finance-kpi] [data-slot]').forEach(slot => slot.replaceChildren());
  for (const id of ['finance-revenue-chart', 'finance-chart-legend', 'finance-income-bar', 'finance-income-list', 'finance-wallet-donut', 'finance-wallet-legend', 'finance-table-head', 'finance-table-body', 'finance-statement']) byId(id).replaceChildren();
  for (const id of ['finance-revenue-trend', 'finance-income-total', 'finance-table-footer', 'finance-table-count', 'finance-basis-note', 'finance-notice']) byId(id).textContent = '';
  byId('finance-notice').hidden = true;
  byId('finance-empty').hidden = true;
  byId('finance-source').textContent = 'Consultando';
}

function download(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = el('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportFinance(kind) {
  if (!session || !financeView) { message('admin-message', 'Aguarde o relatório financeiro carregar antes de exportar.', 'error'); return; }
  const name = financeFileName(financeView, kind);
  if (kind === 'csv') download(name, 'text/csv;charset=utf-8', financeCsv(financeView));
  else download(name, 'application/json', `${JSON.stringify(financeReport(financeView), null, 2)}\n`);
  message('admin-message', `${kind === 'csv' ? 'Planilha' : 'Relatório'} ${name} gerado${financeView.source === 'fallback' ? ' com a estimativa local' : ''}.`, 'success');
}

function setPeriod(period) {
  if (!FINANCE_PERIODS.includes(period) || period === currentPeriod) return;
  currentPeriod = period;
  document.querySelectorAll('.adm-period-btn').forEach(button => {
    const active = button.dataset.period === period;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  byId('finance-report-period').textContent = PERIOD_LABELS[period];
  void loadFinance();
}

function initFinanceControls() {
  document.querySelectorAll('.adm-period-btn').forEach(button => button.addEventListener('click', () => setPeriod(button.dataset.period)));
  document.querySelectorAll('[data-chart-mode]').forEach(button => button.addEventListener('click', () => {
    chartMode = button.dataset.chartMode;
    document.querySelectorAll('[data-chart-mode]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    renderChart();
  }));
  const tabs = [...document.querySelectorAll('#finance-table-tabs [data-fin-filter]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => { financeFilter = tab.dataset.finFilter; renderFinanceTable(); });
    tab.addEventListener('keydown', event => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = tabs[(index + step + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
  });
  byId('finance-search').addEventListener('input', event => { financeQuery = event.target.value.slice(0, 120); renderFinanceTable(); });
  for (const [id, kind] of [['export-finance-csv', 'csv'], ['btn-report-csv', 'csv'], ['export-finance-json', 'json'], ['btn-report-json', 'json']]) byId(id).addEventListener('click', () => exportFinance(kind));
  // O SVG é desenhado na largura real do cartão (texto legível em 300px): redesenha quando o cartão muda de largura.
  let lastWidth = 0, frame = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (!width || Math.abs(width - lastWidth) < 8) return;
    lastWidth = width;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(renderChart);
  }).observe(byId('finance-revenue-chart'));
}

async function initializeAdmin() {
  try {
    const data = await api('/v1/web/session');
    if (data.authenticated !== true || data.profile?.role !== 'admin' || typeof data.csrfToken !== 'string' || !data.csrfToken.trim()) {
      denyAccess(data.authenticated === true ? 'Sua conta não tem acesso à administração.' : 'Entre com uma conta administrativa para continuar.');
      return;
    }
    session = data;
    byId('admin-content').hidden = false;
    initCodes(session, { onDenied: denyAccess });
    initCoupons(session, { onDenied: denyAccess });
    initBugs(session, { onDenied: denyAccess });
    await loadAccounts();
  } catch (error) { denyAccess(error.message); }
}

initShell();
initFinanceControls();
byId('filter-form').addEventListener('submit', event => { event.preventDefault(); closeAction(); void loadAccounts(); });
for (const id of ['status-filter', 'engagement-filter']) byId(id).addEventListener('change', () => { closeAction(); void loadAccounts(); });
document.querySelectorAll('.quick-filter').forEach(button => button.addEventListener('click', () => applyFilters(button.dataset.status, button.dataset.engagement)));
byId('accounts-more').addEventListener('click', () => { void loadAccounts({ append: true }); });
byId('admin-action-form').addEventListener('submit', submitAction);
byId('cancel-admin-action').addEventListener('click', closeAction);
void initializeAdmin();

byId('refresh-activity').addEventListener('click', () => { if (!isBusy) void loadAccounts(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshActivity(); });
setInterval(() => { if (!document.hidden) void refreshActivity(); }, 60_000);
