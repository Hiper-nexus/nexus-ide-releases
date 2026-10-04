import { api, byId, displayDate, message } from './account.js';
import {
  COUPON_INTERVALS, COUPON_STATUS_LABELS, couponFormToBody, couponIntervalsLabel, couponKindLabel,
  couponStatus, couponUsesLabel, couponValueLabel, parseCouponsResponse,
} from './plans/admin-coupons.js';

/**
 * Tela "Cupons de desconto" do painel admin. Rede e DOM aqui; as regras ficam
 * em plans/admin-coupons.js. Todo texto entra por textContent.
 */
const FIELD_IDS = { code: 'coupon-code-field', kind: 'coupon-kind', value: 'coupon-value', intervals: 'coupon-intervals', expires: 'coupon-expires', maxRedemptions: 'coupon-max' };
let session = null, onDenied = () => {}, busy = false, pendingDisable = null, coupons = [];

function setBusy(value) {
  busy = value;
  document.querySelectorAll('#coupon-form input, #coupon-form select, #coupon-submit, #refresh-coupons, #coupon-rows button').forEach((el) => { el.disabled = value; });
}

function showError(text, field) {
  const error = byId('coupon-error');
  error.textContent = text;
  error.hidden = false;
  if (field) byId(FIELD_IDS[field])?.focus();
}

function hideError() { byId('coupon-error').hidden = true; }

function denied(error) {
  if (error?.status === 401 || error?.status === 403) { onDenied(error.message); return true; }
  return false;
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function statusCell(status) {
  const td = document.createElement('td'), pill = document.createElement('span');
  pill.className = 'admin-code-pill';
  pill.dataset.status = status;
  pill.textContent = COUPON_STATUS_LABELS[status];
  td.append(pill);
  return td;
}

function button(text, label, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = text;
  if (label) el.setAttribute('aria-label', label);
  el.addEventListener('click', onClick);
  return el;
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    message('admin-message', `Código ${code} copiado.`, 'success');
  } catch {
    message('admin-message', 'Não foi possível copiar sozinho. Selecione o código na tabela e copie com Ctrl+C ou ⌘C.', 'error');
  }
}

function actionsCell(coupon, status) {
  const td = document.createElement('td'), group = document.createElement('div');
  group.className = 'admin-row-actions';
  group.append(button('Copiar', `Copiar cupom ${coupon.code}`, () => void copyCode(coupon.code)));
  if (coupon.active === true) {
    if (pendingDisable === coupon.id) {
      const warning = document.createElement('p');
      warning.className = 'admin-code-confirm';
      warning.setAttribute('role', 'alert');
      warning.textContent = `Desligar ${coupon.code}? Checkouts novos deixam de aceitá-lo. O histórico de usos permanece.`;
      group.append(warning,
        button('Confirmar', `Confirmar desligar ${coupon.code}`, () => void disable(coupon)),
        button('Cancelar', `Cancelar desligar ${coupon.code}`, () => { pendingDisable = null; render(); }));
    } else {
      group.append(button('Desligar', `Desligar cupom ${coupon.code}`, () => { pendingDisable = coupon.id; render(); }));
    }
  }
  td.append(group);
  void status;
  return td;
}

function couponRow(coupon, now) {
  const status = couponStatus(coupon, now), row = document.createElement('tr'), code = document.createElement('td');
  code.className = 'admin-coupon-code';
  code.textContent = coupon.code;
  row.append(
    code,
    cell(couponKindLabel(coupon.kind)),
    cell(couponValueLabel(coupon)),
    cell(couponUsesLabel(coupon)),
    cell(coupon.expiresAt ? displayDate(coupon.expiresAt) : 'Sem prazo'),
    cell(couponIntervalsLabel(coupon.intervals)),
    statusCell(status),
    actionsCell(coupon, status),
  );
  return row;
}

function render() {
  const now = Date.now();
  byId('coupon-rows').replaceChildren(...coupons.map((coupon) => couponRow(coupon, now)));
  byId('coupons-empty').hidden = coupons.length > 0;
  if (busy) setBusy(true);
}

function selectedIntervals() {
  return [...document.querySelectorAll('#coupon-intervals input:checked')].map((input) => input.value);
}

async function loadCoupons() {
  if (!session) return false;
  setBusy(true);
  try {
    coupons = parseCouponsResponse(await api('/v1/admin/coupons'));
    pendingDisable = null;
    render();
    return true;
  } catch (error) {
    if (!denied(error)) message('admin-message', error.message, 'error');
    return false;
  } finally { setBusy(false); }
}

function resetForm() {
  byId('coupon-code-field').value = '';
  byId('coupon-kind').value = 'percent';
  byId('coupon-value').value = '';
  byId('coupon-expires').value = '';
  byId('coupon-max').value = '';
  for (const input of document.querySelectorAll('#coupon-intervals input')) input.checked = true;
}

async function createCoupon(event) {
  event.preventDefault();
  if (busy || !session) return;
  hideError();
  const form = couponFormToBody({
    code: byId('coupon-code-field').value,
    kind: byId('coupon-kind').value,
    value: byId('coupon-value').value,
    intervals: selectedIntervals(),
    expires: byId('coupon-expires').value,
    maxRedemptions: byId('coupon-max').value,
  });
  if (!form.ok) { showError(form.error, form.field); return; }
  setBusy(true);
  try {
    const created = await api('/v1/admin/coupons', { method: 'POST', csrfToken: session.csrfToken, body: form.body });
    if (!created || created.code !== form.body.code) throw new Error('O servidor não confirmou o cupom. Atualize a lista antes de entregar o código.');
    resetForm();
    setBusy(false);
    if (await loadCoupons()) message('admin-message', `Cupom ${created.code} criado. Copie o código na lista e entregue a quem for usar.`, 'success');
  } catch (error) {
    if (!denied(error)) showError(error.message);
  } finally { setBusy(false); }
}

async function disable(coupon) {
  if (busy || !session) return;
  setBusy(true);
  try {
    await api(`/v1/admin/coupons/${encodeURIComponent(coupon.id)}/disable`, { method: 'POST', csrfToken: session.csrfToken });
    setBusy(false);
    if (await loadCoupons()) message('admin-message', `Cupom ${coupon.code} desligado. O histórico de usos continua na lista.`, 'success');
  } catch (error) {
    if (!denied(error)) { message('admin-message', error.message, 'error'); pendingDisable = null; setBusy(false); await loadCoupons(); }
  } finally { setBusy(false); }
}

export function initCoupons(adminSession, options = {}) {
  session = adminSession;
  onDenied = options.onDenied ?? (() => {});
  byId('coupon-form').addEventListener('submit', (event) => void createCoupon(event));
  byId('refresh-coupons').addEventListener('click', () => { hideError(); void loadCoupons(); });
  void loadCoupons();
}

export function resetCoupons() {
  session = null;
  pendingDisable = null;
  coupons = [];
  const rows = byId('coupon-rows');
  if (rows) rows.replaceChildren();
  const reveal = byId('coupon-error');
  if (reveal) reveal.hidden = true;
}
