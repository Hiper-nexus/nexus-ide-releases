import { useEffect, useRef, useState } from 'react';
import type { BrowserProfileChange, BrowserProfileStatus, ChromeImportResult, ChromeProfileSummary, ChromeSiteSummary } from '../../shared/browser-profile';
import '../styles/browser-profile.css';

const friendlyError = (reason: unknown, fallback: string): string =>
  reason instanceof Error
    ? reason.message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
    : fallback;

/**
 * Endereço digitado ("github.com", "https://…") → URL http(s) para abrir na
 * aba; qualquer outro esquema (file:, javascript:…) ou texto inválido → null.
 */
export function siteSignInUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function BrowserProfilePanel({ paneId, onClose }: { paneId: string; onClose(): void }) {
  const [status, setStatus] = useState<BrowserProfileStatus | null>(null);
  const [profiles, setProfiles] = useState<ChromeProfileSummary[]>([]);
  const [profileId, setProfileId] = useState('');
  const [sites, setSites] = useState<ChromeSiteSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingSites, setLoadingSites] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ChromeImportResult | null>(null);
  const [siteAddress, setSiteAddress] = useState('');
  const resultRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { resultRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [result, error]);

  useEffect(() => {
    let current = true;
    void Promise.all([window.nexus.browser.profileStatus(paneId), window.nexus.browser.chromeProfiles(paneId)])
      .then(([next, available]) => {
        if (!current) return;
        setStatus(next); setProfiles(available); setProfileId(available[0]?.id ?? '');
      }).catch((reason: unknown) => { if (current) setError(friendlyError(reason, 'Não foi possível abrir o perfil.')); });
    return () => { current = false; };
  }, [paneId]);

  useEffect(() => {
    let current = true;
    setSites([]); setSelected(new Set()); setResult(null);
    if (!profileId) return () => { current = false; };
    setLoadingSites(true);
    void window.nexus.browser.chromeSites(paneId, profileId)
      .then((next) => { if (current) setSites(next); })
      .catch((reason: unknown) => { if (current) setError(friendlyError(reason, 'Não foi possível listar os sites.')); })
      .finally(() => { if (current) setLoadingSites(false); });
    return () => { current = false; };
  }, [paneId, profileId]);

  async function change(change: BrowserProfileChange): Promise<void> {
    setBusy(true); setError('');
    try { setStatus(await window.nexus.browser.profileChange(paneId, change)); }
    catch (reason) { setError(friendlyError(reason, 'Não foi possível mudar o perfil.')); }
    finally { setBusy(false); }
  }

  async function importSites(): Promise<void> {
    setBusy(true); setError(''); setResult(null);
    try {
      const imported = await window.nexus.browser.chromeImport(paneId, profileId, [...selected]);
      setResult(imported);
      setStatus(await window.nexus.browser.profileStatus(paneId));
    } catch (reason) { setError(friendlyError(reason, 'Não foi possível importar as sessões.')); }
    finally { setBusy(false); }
  }
  /**
   * Sem importação (Windows/Linux): a aba passa ao Perfil Nexus e abre o site
   * para o operador entrar uma vez; o login fica no Perfil Nexus.
   */
  async function openForSignIn(): Promise<void> {
    const url = siteSignInUrl(siteAddress);
    if (!url) { setError('Digite o endereço de um site, como github.com.'); return; }
    setBusy(true); setError('');
    try {
      if (status?.mode !== 'personal') setStatus(await window.nexus.browser.profileChange(paneId, { mode: 'personal' }));
      await window.nexus.browser.load(paneId, url);
      onClose();
    } catch (reason) { setError(friendlyError(reason, 'Não foi possível abrir o site.')); }
    finally { setBusy(false); }
  }
  const skipped = result ? Object.values(result.skipped).reduce((total, count) => total + count, 0) : 0;
  const visibleSites = sites.filter((site) => site.domain.toLowerCase().includes(filter.toLowerCase().trim()));

  return <section className="browser-profile nodrag" aria-label="Perfil e logins" aria-busy={busy}>
    <div className="browser-profile__header">
      <div><strong>Perfil e logins</strong><p>Reutilize sessões dos seus sites no Nexus.</p></div>
      <button type="button" className="browser-profile__button" onClick={onClose}>Fechar</button>
    </div>
    {!status && !error && <p role="status">Abrindo perfil…</p>}
    {status && <>
      <div className="browser-profile__modes" aria-label="Perfil desta aba">
        <button type="button" className="browser-profile__button" aria-pressed={status.mode === 'personal'} disabled={busy} onClick={() => void change({ mode: 'personal' })}>Perfil Nexus</button>
        <button type="button" className="browser-profile__button" aria-pressed={status.mode === 'isolated'} disabled={busy} onClick={() => void change({ mode: 'isolated' })}>Isolado</button>
      </div>
      <p>{status.mode === 'personal' ? 'Esta aba reutiliza as sessões compatíveis do Perfil Nexus. Alguns sites ainda podem pedir login em cada aba.' : 'Esta aba mantém seus logins separados do Perfil Nexus.'}</p>
      <label className="browser-profile__check">
        <input type="checkbox" checked={status.shareWithAgents} disabled={busy} onChange={(event) => void change({ shareWithAgents: event.currentTarget.checked })} />
        Usar o perfil em novos navegadores dos agentes
      </label>
      <p>Quando ativado, os agentes poderão acessar os sites em que você já entrou.</p>
      {status.notice && <p role="status">{status.notice}</p>}
      {!status.importSupported ? <div className="browser-profile__import">
        <strong>Entrar nos seus sites</strong>
        <p>Neste sistema o Chrome protege os logins dele contra leitura por outros programas, então eles não são importados. Entre uma vez em cada site pelo Perfil Nexus: o login fica salvo{status.shareWithAgents ? ' e os agentes passam a usá-lo' : ''}.</p>
        <form className="browser-profile__signin" onSubmit={(event) => { event.preventDefault(); void openForSignIn(); }}>
          <input className="browser-profile__search" aria-label="Site para entrar" placeholder="ex.: github.com" value={siteAddress} disabled={busy} onChange={(event) => { setError(''); setSiteAddress(event.currentTarget.value); }} />
          <button type="submit" className="browser-profile__button browser-profile__button--primary" disabled={busy || !siteAddress.trim()}>{status.mode === 'personal' ? 'Abrir para entrar' : 'Usar o Perfil Nexus e abrir'}</button>
        </form>
      </div> : <div className="browser-profile__import">
        <strong>Importar do Chrome</strong>
        <p>Escolha o perfil e os sites. O Chrome permanece intacto; alguns sites podem pedir novo login. Senhas e extensões não são importadas.</p>
        {!profiles.length ? <p>Nenhum perfil do Chrome encontrado. Use o Perfil Nexus para entrar nos sites.</p> : <>
          <label className="browser-profile__field">Perfil do Chrome
            <select value={profileId} disabled={busy} onChange={(event) => { setError(''); setProfileId(event.currentTarget.value); }}>
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          </label>
          <input className="browser-profile__search" aria-label="Filtrar sites do Chrome" placeholder="Filtrar sites" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} />
          <div className="browser-profile__sites" aria-label="Sites disponíveis">
            {loadingSites ? <p role="status">Lendo sites…</p> : !visibleSites.length ? <p>Nenhum site encontrado.</p> : visibleSites.map((site) => <label key={site.domain} className="browser-profile__check">
              <input type="checkbox" aria-label={`Importar ${site.domain}`} checked={selected.has(site.domain)} disabled={busy || (!selected.has(site.domain) && selected.size >= 200)} onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelected((previous) => { const next = new Set(previous); if (checked) next.add(site.domain); else next.delete(site.domain); return next; });
              }} />{site.domain}
            </label>)}
          </div>
          <div className="browser-profile__actions">
            <span>{selected.size} selecionado{selected.size === 1 ? '' : 's'}</span>
            <button type="button" className="browser-profile__button browser-profile__button--primary" disabled={busy || loadingSites || !selected.size} onClick={() => void importSites()}>{busy ? 'Aguarde…' : 'Importar sites selecionados'}</button>
          </div>
        </>}
      </div>}
    </>}
    {result && <p ref={resultRef} role="status">Dados de sessão de {result.importedSites} site{result.importedSites === 1 ? '' : 's'} importados. {skipped > 0 ? `${skipped} ${skipped === 1 ? 'item expirado ou incompatível não foi importado' : 'itens expirados ou incompatíveis não foram importados'}. ` : ''}Abra o site para conferir o login.</p>}
    {error && <p className="browser-profile__error" role="alert">{error}</p>}
  </section>;
}
