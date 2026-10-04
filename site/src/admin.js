import { api, byId, message, displayDate, subscriptionLabel, ACCESS_LABELS } from './account.js';
import { initCodes, resetCodes } from './admin-codes.js';
import { initBugs, resetBugs } from './admin-bugs.js';
import { accountsQuery, parseAccountsPage } from './plans/admin-accounts.js';

const ACTIONS = { suspend: 'Suspender acesso', resume: 'Restaurar acesso', 'extend-trial': 'Estender teste' };
let session = null, selectedAction = null, isBusy = false, accountsCursor = null;

function denyAccess(text) {
  session = null;
  resetCodes();
  resetBugs();
  selectedAction = null;
  byId('admin-content').hidden = true;
  byId('admin-denied').hidden = false;
  byId('admin-overview').replaceChildren();
  byId('account-rows').replaceChildren();
  accountsCursor = null;
  byId('accounts-more').hidden = true;
  byId('admin-action-panel').hidden = true;
  byId('action-account').textContent = '';
  message('admin-message', text, 'error');
}

function setBusy(value) {
  isBusy = value;
  document.querySelectorAll('#filter-form button, #filter-form select, #filter-form input, #accounts-more, .admin-row-actions button, #admin-action-form button').forEach(button => { button.disabled = value; });
}

function renderOverview(data) {
  const metrics = [['accounts', 'Contas'], ['trial', 'Em teste'], ['active', 'Ativas'], ['suspended', 'Suspensas'], ['expired', 'Teste encerrado']];
  if (!metrics.every(([key]) => Number.isInteger(data[key]) && data[key] >= 0)) throw new Error('O serviço não retornou um resumo válido. Atualize novamente.');
  byId('admin-overview').replaceChildren(...metrics.map(([key, label]) => {
    const item = document.createElement('div'), title = document.createElement('dt'), count = document.createElement('dd');
    title.textContent = label;
    count.textContent = new Intl.NumberFormat('pt-BR').format(data[key]);
    item.append(title, count);
    return item;
  }));
  byId('admin-overview').hidden = false;
}

function textCell(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

function lastSeenCell(value) {
  const cell = document.createElement('td');
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    cell.textContent = 'Sem registro';
    return cell;
  }
  const time = document.createElement('time');
  time.dateTime = value;
  time.textContent = displayDate(value);
  cell.append(time);
  return cell;
}

function accountRow(account) {
  const row = document.createElement('tr'), identity = document.createElement('td');
  const name = document.createElement('strong'), email = document.createElement('small');
  name.textContent = account.name || 'Sem nome informado';
  email.textContent = account.email;
  identity.append(name, email);
  const actions = document.createElement('td'), group = document.createElement('div');
  group.className = 'admin-row-actions';
  for (const action of [account.access === 'suspended' ? 'resume' : 'suspend', 'extend-trial']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = ACTIONS[action];
    button.setAttribute('aria-label', `${ACTIONS[action]} de ${account.email}`);
    button.addEventListener('click', () => openAction(account, action));
    group.append(button);
  }
  actions.append(group);
  row.append(identity, textCell(ACCESS_LABELS[account.access] || 'A confirmar'), textCell(displayDate(account.trialEndsAt)),
    textCell(subscriptionLabel(account.subscriptionStatus)), textCell(account.role === 'admin' ? 'Administrador' : 'Usuário'), lastSeenCell(account.lastSeenAt), actions);
  return row;
}

function renderAccounts(data, { append }) {
  const page = parseAccountsPage(data);
  if (!page) throw new Error('O serviço não retornou uma lista válida. Atualize novamente.');
  const rows = page.accounts.map(accountRow);
  if (append) byId('account-rows').append(...rows);
  else byId('account-rows').replaceChildren(...rows);
  accountsCursor = page.nextCursor;
  byId('accounts-empty').hidden = byId('account-rows').children.length > 0;
  byId('accounts-more').hidden = page.nextCursor === null;
}

async function loadAccounts({ append = false } = {}) {
  if (isBusy || !session) return false;
  if (append && !accountsCursor) return false;
  setBusy(true);
  if (!append) {
    accountsCursor = null;
    byId('account-rows').replaceChildren();
    byId('admin-overview').hidden = true;
  }
  byId('accounts-empty').hidden = true;
  byId('accounts-more').hidden = true;
  message('admin-message', append ? 'Carregando mais contas…' : 'Consultando contas e períodos de teste…');
  const listCall = api(`/v1/admin/accounts?${accountsQuery({ status: byId('account-filter').value, email: byId('account-email').value, cursor: append ? accountsCursor : undefined })}`);
  const results = await Promise.allSettled(append ? [listCall] : [api('/v1/admin/overview'), listCall]);
  const errors = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === 'rejected') { errors.push(result.reason); continue; }
    try { if (!append && index === 0) renderOverview(result.value); else renderAccounts(result.value, { append }); }
    catch (error) { errors.push(error); }
  }
  setBusy(false);
  const permissionError = errors.find(error => error.status === 401 || error.status === 403);
  if (permissionError) { denyAccess(permissionError.message); return false; }
  if (errors.length && append && accountsCursor) byId('accounts-more').hidden = false;
  message('admin-message', errors.length ? errors[0].message : 'Dados atualizados pelo servidor.', errors.length ? 'error' : '');
  return errors.length === 0;
}

function closeAction() {
  selectedAction = null;
  byId('admin-action-panel').hidden = true;
  byId('action-error').hidden = true;
  byId('account-filter').focus();
}

function openAction(account, action) {
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
  byId('trial-days').value = '7';
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
    initBugs(session, { onDenied: denyAccess });
    await loadAccounts();
  } catch (error) { denyAccess(error.message); }
}

byId('filter-form').addEventListener('submit', event => { event.preventDefault(); closeAction(); void loadAccounts(); });
byId('accounts-more').addEventListener('click', () => { void loadAccounts({ append: true }); });
byId('admin-action-form').addEventListener('submit', submitAction);
byId('cancel-admin-action').addEventListener('click', closeAction);
void initializeAdmin();
