import { useEffect, useState } from 'react';
import { decisionSettingsSchema, type DecisionModelStatus } from '../../../shared/decision-models';
import { openExternalFromAnchor } from '../../lib/open-external';

const ACCOUNT_HINT_ID = 'decision-models-account-hint';
const ACCOUNT_ERROR = 'Informe um Account ID Cloudflare com 32 caracteres hexadecimais.';

interface ClefCredentialsProps {
  status: DecisionModelStatus; busy: boolean;
  run: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
  onError: (message: string) => void;
  /** Id of the error element rendered by the parent, when there is one. */
  errorId?: string;
}

/** Account ID (settings) and API token (vault) are saved by separate actions: neither depends on retyping the other. */
export function ClefCredentials({ status, busy, run, onError, errorId }: ClefCredentialsProps) {
  const [accountId, setAccountId] = useState(status.accountId);
  const [token, setToken] = useState('');
  const [accountInvalid, setAccountInvalid] = useState(false);
  useEffect(() => { setAccountId(status.accountId); setAccountInvalid(false); }, [status.accountId]);
  const accountDirty = accountId.trim() !== status.accountId;

  async function saveAccountId() {
    const parsed = decisionSettingsSchema.safeParse({ ...status.settings, cloudflareAccountId: accountId.trim() });
    if (!parsed.success || !parsed.data.cloudflareAccountId) { setAccountInvalid(true); onError(ACCOUNT_ERROR); return; }
    await run(async () => {
      const settings = await window.nexus.settings.orchSet({ decisionModels: parsed.data });
      if (settings.decisionModels.cloudflareAccountId !== parsed.data.cloudflareAccountId) throw new Error('Não consegui salvar o Account ID.');
    }, 'Account ID salvo.');
  }
  async function saveToken() {
    const saved = await run(async () => {
      const result = await window.nexus.decisionModels.setKey({ token });
      if (!result.ok) throw new Error(result.error ?? 'Não consegui guardar o token no cofre.');
    }, 'Token Cloudflare salvo no cofre.');
    if (saved) setToken('');
  }
  async function removeToken() {
    const removed = await run(async () => {
      const result = await window.nexus.decisionModels.setKey({ token: '' });
      if (!result.ok) throw new Error(result.error ?? 'Não consegui remover o token.');
    }, 'Token Cloudflare removido.');
    if (removed) setToken('');
  }
  const accountDescription = [accountDirty ? ACCOUNT_HINT_ID : '', accountInvalid && errorId ? errorId : ''].filter(Boolean).join(' ') || undefined;
  return <div className="decision-models__credentials">
    <div className="settings-form-grid">
      <label className="settings-field">Account ID
        <input className="settings-input" aria-label="Account ID Cloudflare" autoComplete="off" spellCheck={false}
          value={accountId} disabled={busy} aria-invalid={accountInvalid || undefined} aria-describedby={accountDescription}
          onChange={event => { setAccountId(event.target.value); setAccountInvalid(false); }} />
      </label>
      <label className="settings-field">API Token
        <input className="settings-input" aria-label="API Token Cloudflare" type="password" autoComplete="new-password"
          placeholder={status.keyMasked ?? 'Token com permissão Workers AI'} value={token} disabled={busy}
          onChange={event => setToken(event.target.value)} />
      </label>
    </div>
    {accountDirty && <p id={ACCOUNT_HINT_ID} className="settings-field__note settings-field__note--warning">Account ID ainda não salvo.</p>}
    <div className="settings-row decision-models__actions">
      <button className="settings-btn" type="button" disabled={busy || !accountDirty} onClick={() => void saveAccountId()}>Salvar Account ID</button>
      <button className="settings-btn" type="button" disabled={busy || !token.trim()} onClick={() => void saveToken()}>Salvar token</button>
      <button className="settings-btn settings-btn--sm" type="button" disabled={busy || !status.isReady} onClick={() => void run(async () => {
        const result = await window.nexus.decisionModels.test({ model: status.settings.clefModel });
        if (!result.ok) throw new Error(result.detail);
      }, 'Conexão Cloudflare confirmada.')}>Testar conexão</button>
      <button className="settings-btn settings-btn--sm" type="button" disabled={busy || !status.hasStoredKey} onClick={() => void removeToken()}>Remover token</button>
    </div>
    <p className="settings-field__note">{status.hasStoredKey ? `Token guardado: ${status.keyMasked ?? '••••'}.` : status.hasEnv ? 'Token fornecido pelo ambiente (NEXUS_CLEF_API_TOKEN).' : 'Nenhum token Cloudflare configurado.'}
      {' '}O teste executa uma pequena consulta de inferência.</p>
    <a className="settings-link" href="https://dash.cloudflare.com/?to=/:account/ai/workers-ai"
      onClick={event => openExternalFromAnchor(event, 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai')}>Abrir Workers AI para obter Account ID e API Token</a>
  </div>;
}
