import { useEffect, useState } from 'react';
import { decisionSettingsSchema, type DecisionModelStatus } from '../../../shared/decision-models';
import { openExternalFromAnchor } from '../../lib/open-external';

export function ClefCredentials({ status, busy, run, onError }: {
  status: DecisionModelStatus; busy: boolean;
  run: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const [accountId, setAccountId] = useState(status.accountId);
  const [token, setToken] = useState('');
  useEffect(() => { setAccountId(status.accountId); }, [status.accountId]);
  async function save() {
    const parsed = decisionSettingsSchema.safeParse({ ...status.settings, cloudflareAccountId: accountId });
    if (!parsed.success || !parsed.data.cloudflareAccountId) { onError('Informe um Account ID Cloudflare com 32 caracteres hexadecimais.'); return; }
    const saved = await run(async () => {
      const settings = await window.nexus.settings.orchSet({ decisionModels: parsed.data });
      if (settings.decisionModels.cloudflareAccountId !== parsed.data.cloudflareAccountId) throw new Error('Não consegui salvar o Account ID.');
      const result = await window.nexus.decisionModels.setKey({ token });
      if (!result.ok) throw new Error(result.error ?? 'Não consegui guardar o token no cofre.');
    }, 'Token Cloudflare salvo no cofre.');
    if (saved) setToken('');
  }
  return <div className="decision-models__credentials">
    <div className="settings-form-grid">
      <label className="settings-field">Account ID
        <input className="settings-input" aria-label="Account ID Cloudflare" autoComplete="off" spellCheck={false}
          value={accountId} onChange={event => setAccountId(event.target.value)} disabled={busy} />
      </label>
      <label className="settings-field">API Token
        <input className="settings-input" aria-label="API Token Cloudflare" type="password" autoComplete="new-password"
          placeholder={status.keyMasked ?? 'Token com permissão Workers AI'} value={token} disabled={busy}
          onChange={event => setToken(event.target.value)} />
      </label>
    </div>
    <div className="settings-row decision-models__actions">
      <button className="settings-btn" type="button" disabled={busy || !token.trim()} onClick={() => void save()}>Salvar token</button>
      <button className="settings-btn settings-btn--sm" type="button" disabled={busy || !status.isReady} onClick={() => void run(async () => {
        const result = await window.nexus.decisionModels.test({ model: status.settings.clefModel });
        if (!result.ok) throw new Error(result.detail);
      }, 'Conexão Cloudflare confirmada.')}>Testar conexão</button>
      <button className="settings-btn settings-btn--sm" type="button" disabled={busy || !status.hasStoredKey} onClick={() => void run(async () => {
        const result = await window.nexus.decisionModels.setKey({ token: '' });
        if (!result.ok) throw new Error(result.error ?? 'Não consegui remover o token.');
      }, 'Token Cloudflare removido.')}>Remover token</button>
    </div>
    <p className="settings-field__note">{status.hasStoredKey ? `Token guardado: ${status.keyMasked ?? '••••'}.` : status.hasEnv ? 'Token fornecido pelo ambiente.' : 'Nenhum token Cloudflare configurado.'}
      {' '}O teste executa uma pequena consulta de inferência.</p>
    <a className="settings-link" href="https://dash.cloudflare.com/?to=/:account/ai/workers-ai"
      onClick={event => openExternalFromAnchor(event, 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai')}>Abrir Workers AI para obter Account ID e API Token</a>
  </div>;
}
