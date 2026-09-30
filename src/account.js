import '@fontsource-variable/geist';
import './account.css';

export const API_ORIGIN = 'https://api.nexuside.app';
export const byId = id => document.getElementById(id);
export const ACCESS_LABELS = { trial: 'Período de teste', pro: 'Nexus Pro', suspended: 'Acesso suspenso', inactive: 'Sem acesso ativo', expired: 'Teste encerrado' };
const SUBSCRIPTION_LABELS = { active: 'Ativa', trialing: 'Em teste', past_due: 'Pagamento pendente', canceled: 'Cancelada', unpaid: 'Não paga', incomplete: 'Pagamento incompleto', incomplete_expired: 'Pagamento expirado', none: 'Não contratada' };
let session = { authenticated: false }, availability = null, isBusy = false;

export async function api(path, { method = 'GET', body, csrfToken } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    if (typeof csrfToken !== 'string' || !csrfToken.trim()) throw new Error('Atualize a página antes de continuar.');
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfToken;
  }
  let response;
  try {
    response = await fetch(API_ORIGIN + path, { method, credentials: 'include', headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) });
  } catch { throw new Error('Não foi possível conectar ao serviço. Tente novamente.'); }
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'Sua sessão expirou. Entre novamente.'
      : response.status === 403 ? 'Sua conta não tem permissão para esta ação.'
      : response.status === 429 ? 'Muitas tentativas. Aguarde um momento antes de continuar.'
      : 'Não foi possível concluir a solicitação. Tente novamente.');
    error.status = response.status;
    throw error;
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error('O serviço retornou uma resposta inválida. Tente novamente.'); }
  if (payload?.ok !== true || !payload.data || typeof payload.data !== 'object') throw new Error('O serviço não confirmou a solicitação. Atualize a página e tente novamente.');
  return payload.data;
}

export function displayDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Não informado';
}

export function subscriptionLabel(value) { return SUBSCRIPTION_LABELS[value] || 'A confirmar'; }

export function message(id, text, state = '') {
  const target = byId(id);
  target.textContent = text;
  target.dataset.state = state;
}

function validatedSession(data) {
  if (data.authenticated === false) return data;
  if (data.authenticated !== true || typeof data.profile?.email !== 'string' || typeof data.profile?.id !== 'string'
    || typeof data.profile?.role !== 'string' || !Object.hasOwn(ACCESS_LABELS, data.entitlement?.access)
    || typeof data.csrfToken !== 'string' || !data.csrfToken.trim()) throw new Error('Não foi possível confirmar os dados da conta. Entre novamente.');
  return data;
}

function renderIdentity() {
  const authenticated = session.authenticated === true;
  byId('signed-in').hidden = !authenticated;
  byId('signed-out').hidden = authenticated;
  byId('identity-title').textContent = authenticated ? 'Minha conta.' : 'Entre na sua conta.';
  if (!authenticated) return;
  const entitlement = session.entitlement;
  byId('profile-name').textContent = session.profile.name || 'Minha conta';
  byId('profile-email').textContent = session.profile.email;
  byId('admin-link').hidden = session.profile.role !== 'admin';
  byId('access-label').textContent = ACCESS_LABELS[entitlement.access];
  byId('trial-end-row').hidden = entitlement.access !== 'trial';
  byId('trial-end').textContent = displayDate(entitlement.trialEndsAt);
  byId('agent-limit').textContent = Number.isInteger(entitlement.maxAgents) ? String(entitlement.maxAgents) : 'A confirmar';
  byId('subscription-status').textContent = subscriptionLabel(entitlement.status);
}

function renderAvailability() {
  const billing = availability?.billing;
  const billingReady = availability?.ready === true && billing?.available === true;
  for (const provider of ['google', 'github']) byId(`login-${provider}`).hidden = availability?.auth?.[provider] !== true;
  byId('login-status').textContent = availability?.auth?.google || availability?.auth?.github
    ? 'O login usa sua conta do provedor escolhido.' : 'Login temporariamente indisponível. Tente novamente mais tarde.';
  byId('subscribe').disabled = isBusy || !billingReady || !session.authenticated || session.entitlement?.access === 'pro';
  byId('logout').disabled = isBusy;
  byId('refresh-account').disabled = isBusy;
  byId('billing-portal').hidden = !session.authenticated || !['pro'].includes(session.entitlement?.plan);
  byId('billing-portal').disabled = isBusy || !billingReady;
  byId('billing-status').textContent = !billingReady ? 'A contratação está temporariamente indisponível. Nenhuma cobrança será iniciada.'
    : !session.authenticated ? 'Entre na sua conta para contratar.' : session.entitlement.access === 'pro'
      ? 'Seu acesso Pro está confirmado. Use o portal para gerenciar a cobrança.' : 'Ao continuar, você será levado ao checkout seguro do Stripe.';
  if (billing && Number.isInteger(billing.amount) && billing.currency === 'brl' && billing.interval === 'month') {
    byId('pro-price').textContent = `${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(billing.amount / 100)} / mês`;
  } else byId('pro-price').textContent = 'Preço temporariamente indisponível';
  const trial = availability?.trial;
  byId('trial-description').textContent = Number.isInteger(trial?.days) && Number.isInteger(trial.maxAgents)
    ? `${trial.days} dias de teste com até ${trial.maxAgents} agentes simultâneos${trial.cloudSync === false ? ', sem sincronização em nuvem' : ''}.`
    : 'As condições do período de teste estão temporariamente indisponíveis.';
}

async function refreshAccount({ announce = true } = {}) {
  if (isBusy) return;
  isBusy = true;
  byId('refresh-account').disabled = true;
  byId('subscribe').disabled = true;
  message('account-message', 'Atualizando sua conta…');
  const results = await Promise.allSettled([api('/v1/public/status'), api('/v1/web/session')]);
  availability = results[0].status === 'fulfilled' ? results[0].value : null;
  let error = results.find(result => result.status === 'rejected')?.reason;
  try { session = results[1].status === 'fulfilled' ? validatedSession(results[1].value) : { authenticated: false }; }
  catch (validationError) { session = { authenticated: false }; error = validationError; }
  isBusy = false;
  renderIdentity();
  renderAvailability();
  if (announce) message('account-message', error ? error.message : session.authenticated ? 'Conta atualizada. O acesso mostrado foi confirmado pelo servidor.' : 'Entre para começar ou continuar.', error ? 'error' : '');
}

const CHECKOUT_DELAYS = [1200, 2500, 4000];

async function confirmProAccess() {
  for (let attempt = 1; attempt <= CHECKOUT_DELAYS.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, CHECKOUT_DELAYS[attempt - 1]));
    message('account-message', `Recebemos o retorno do Stripe. O servidor ainda vai confirmar o acesso Pro. Tentativa ${attempt} de ${CHECKOUT_DELAYS.length}…`);
    try {
      session = validatedSession(await api('/v1/web/session'));
      renderIdentity();
      renderAvailability();
      if (session.authenticated && session.entitlement?.access === 'pro') return true;
    } catch { /* A próxima tentativa consulta de novo; o resultado final é reportado pelo chamador. */ }
  }
  return false;
}

async function handleCheckoutReturn(kind) {
  if (kind === 'cancel') {
    message('account-message', 'O checkout foi cancelado. Nenhuma cobrança foi iniciada.');
    await refreshAccount();
    message('account-message', 'O checkout foi cancelado. Nenhuma cobrança foi iniciada e o seu acesso não mudou.');
    return;
  }
  message('account-message', 'Recebemos o retorno do Stripe. Confirmando seu acesso com o servidor…');
  await refreshAccount({ announce: false });
  if (session.authenticated && session.entitlement?.access === 'pro') {
    message('account-message', 'Seu acesso Pro está confirmado pelo servidor. Abra o NexusIDE e entre com a mesma conta.', 'success');
    return;
  }
  const confirmed = await confirmProAccess();
  message(confirmed
    ? 'Seu acesso Pro está confirmado pelo servidor. Abra o NexusIDE e entre com a mesma conta.'
    : 'O servidor ainda não confirmou o acesso Pro. Use “Atualizar situação da conta” em instantes para conferir.',
  confirmed ? 'success' : '');
}

function highlightPlan() {
  const panel = document.querySelector('.account-plan');
  panel.classList.add('plan-highlight');
  panel.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function safeStripeUrl(value, hostname) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === hostname && !url.port && !url.username && !url.password) return url.href;
  } catch { /* Rejected URL is reported to the user below. */ }
  throw new Error('O serviço não retornou um endereço de pagamento válido. Tente novamente.');
}

async function billingAction(kind) {
  if (isBusy || byId(kind === 'checkout' ? 'subscribe' : 'billing-portal').disabled) return;
  isBusy = true;
  renderAvailability();
  message('account-message', kind === 'checkout' ? 'Preparando o checkout…' : 'Abrindo o portal de cobrança…');
  try {
    const data = await api(`/v1/web/${kind}`, { method: 'POST', csrfToken: session.csrfToken,
      body: kind === 'checkout' ? { plan: 'pro', attemptId: crypto.randomUUID() } : {} });
    const url = safeStripeUrl(data.url, kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com');
    window.location.assign(url);
  } catch (error) {
    if (error.status === 401 || error.status === 403) { session = { authenticated: false }; renderIdentity(); }
    message('account-message', error.message, 'error');
  } finally { isBusy = false; renderAvailability(); }
}

async function logout() {
  if (isBusy) return;
  isBusy = true;
  renderAvailability();
  try {
    await api('/v1/web/logout', { method: 'POST', csrfToken: session.csrfToken, body: {} });
    session = { authenticated: false };
    renderIdentity();
    message('account-message', 'Você saiu da conta.');
  } catch (error) { message('account-message', error.message, 'error'); }
  finally { isBusy = false; renderAvailability(); }
}

if (document.body.dataset.page === 'account') {
  byId('refresh-account').addEventListener('click', () => refreshAccount());
  byId('subscribe').addEventListener('click', () => billingAction('checkout'));
  byId('billing-portal').addEventListener('click', () => billingAction('portal'));
  byId('logout').addEventListener('click', logout);
  const query = new URLSearchParams(window.location.search);
  const checkout = query.get('checkout');
  if (checkout === 'success' || checkout === 'cancel') void handleCheckoutReturn(checkout);
  else void refreshAccount();
  if (query.get('plano') === 'pro') highlightPlan();
}
