import { api, byId, displayDate, message } from './account.js';
import {
  CODE_STATUS_LABELS, codeFormToBody, codeStatus, durationLabel, maskedCode, mintedCodeFrom, parseCodesResponse, usesLabel,
} from './plans/license-codes.js';

/**
 * Tela "Códigos de licença" do painel admin. Rede e DOM aqui; as regras (limites,
 * situação, formato do código) ficam em plans/license-codes.js, testadas.
 * Todo texto entra por textContent: nada de HTML montado a partir de dado do servidor.
 */
const FIELD_IDS = { periodDays: 'code-days', maxUses: 'code-uses', expiresInDays: 'code-expires', note: 'code-note' };
let session = null, onDenied = () => {}, busy = false, pendingRevoke = null, codes = [];

function setBusy(value) {
  busy = value;
  document.querySelectorAll('#code-form input, #code-submit, #refresh-codes, #code-rows button').forEach(el => { el.disabled = value; });
}

function showError(text, field) {
  const error = byId('code-error');
  error.textContent = text;
  error.hidden = false;
  if (field) byId(FIELD_IDS[field])?.focus();
}

function hideError() { byId('code-error').hidden = true; }

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
  pill.textContent = CODE_STATUS_LABELS[status];
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

function actionsCell(code, status) {
  const td = document.createElement('td'), group = document.createElement('div');
  group.className = 'admin-row-actions';
  if (status === 'revoked') { group.textContent = '—'; td.append(group); return td; }
  const name = `código terminado em ${code.suffix}`;
  if (pendingRevoke === code.id) {
    const warning = document.createElement('p');
    warning.className = 'admin-code-confirm';
    warning.setAttribute('role', 'alert');
    warning.textContent = code.uses > 0
      ? `Isto derruba o acesso das ${code.uses} conta(s) que já resgataram este ${name}.`
      : 'Ninguém resgatou este código ainda.';
    group.append(warning,
      button('Confirmar revogação', `Confirmar revogação do ${name}`, () => void revoke(code)),
      button('Cancelar', `Cancelar revogação do ${name}`, () => { pendingRevoke = null; render(); }));
  } else {
    group.append(button('Revogar', `Revogar ${name}`, () => { pendingRevoke = code.id; render(); }));
  }
  td.append(group);
  return td;
}

function codeRow(code, now) {
  const status = codeStatus(code, now), row = document.createElement('tr'), suffix = document.createElement('td');
  suffix.className = 'admin-code-suffix';
  suffix.textContent = maskedCode(code.suffix);
  row.append(suffix, cell(durationLabel(code.periodDays)), cell(usesLabel(code)),
    cell(code.expiresAt ? displayDate(code.expiresAt) : 'Sem prazo'), cell(code.note || '—'), statusCell(status), actionsCell(code, status));
  return row;
}

function render() {
  const now = Date.now();
  byId('code-rows').replaceChildren(...codes.map(code => codeRow(code, now)));
  byId('codes-empty').hidden = codes.length > 0;
  if (busy) setBusy(true);
}

async function loadCodes() {
  if (!session) return false;
  setBusy(true);
  try {
    codes = parseCodesResponse(await api('/v1/admin/license-codes'));
    pendingRevoke = null;
    render();
    return true;
  } catch (error) {
    if (!denied(error)) message('admin-message', error.message, 'error');
    return false;
  } finally { setBusy(false); }
}

async function mint(event) {
  event.preventDefault();
  if (busy || !session) return;
  hideError();
  const form = codeFormToBody({
    periodDays: byId('code-days').value, maxUses: byId('code-uses').value,
    expiresInDays: byId('code-expires').value, note: byId('code-note').value,
  });
  if (!form.ok) { showError(form.error, form.field); return; }
  setBusy(true);
  try {
    const data = await api('/v1/admin/license-codes', { method: 'POST', csrfToken: session.csrfToken, body: form.body });
    const code = mintedCodeFrom(data);
    // Só exibe o que tem o formato exato de um código: resposta estranha nunca vira "código" na tela.
    if (!code) throw new Error('O servidor não retornou um código válido. Atualize a lista e confira antes de tentar de novo.');
    byId('code-value').textContent = code;
    byId('code-reveal').hidden = false;
    byId('code-copy').textContent = 'Copiar código';
    byId('code-reveal').focus();
    byId('code-days').value = '';
    byId('code-uses').value = '1';
    byId('code-expires').value = '';
    byId('code-note').value = '';
    setBusy(false);
    await loadCodes();
  } catch (error) {
    if (!denied(error)) showError(error.message);
  } finally { setBusy(false); }
}

async function revoke(code) {
  if (busy || !session) return;
  setBusy(true);
  try {
    await api(`/v1/admin/license-codes/${encodeURIComponent(code.id)}/revoke`, { method: 'POST', csrfToken: session.csrfToken });
    setBusy(false);
    if (await loadCodes()) message('admin-message', `Código terminado em ${code.suffix} revogado: o servidor confirmou.`, 'success');
  } catch (error) {
    if (!denied(error)) { message('admin-message', error.message, 'error'); pendingRevoke = null; setBusy(false); await loadCodes(); }
  } finally { setBusy(false); }
}

function dismissReveal() {
  byId('code-value').textContent = '';
  byId('code-reveal').hidden = true;
  byId('code-days').focus();
}

async function copyCode() {
  const value = byId('code-value').textContent;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    byId('code-copy').textContent = 'Copiado';
  } catch {
    byId('code-copy').textContent = 'Copie manualmente';
    showError('Não foi possível copiar sozinho. Selecione o código acima e copie com Ctrl+C ou ⌘C.');
  }
}

export function initCodes(adminSession, options = {}) {
  session = adminSession;
  onDenied = options.onDenied ?? (() => {});
  byId('code-form').addEventListener('submit', mint);
  byId('refresh-codes').addEventListener('click', () => { hideError(); void loadCodes(); });
  byId('code-copy').addEventListener('click', () => void copyCode());
  byId('code-dismiss').addEventListener('click', dismissReveal);
  void loadCodes();
}

/** Perdeu a sessão: nada do que foi exibido (inclusive um código recém-gerado) pode ficar na tela. */
export function resetCodes() {
  session = null;
  pendingRevoke = null;
  codes = [];
  byId('code-value').textContent = '';
  byId('code-reveal').hidden = true;
  byId('code-rows').replaceChildren();
}
