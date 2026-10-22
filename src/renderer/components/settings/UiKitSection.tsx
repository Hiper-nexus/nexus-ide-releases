import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  UiKitCatalogView,
  UiKitIdValue,
  UiKitInstallView,
  UiKitStatusView,
} from '../../../shared/ui-kit-contract';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * UI kits: shadcn/ui and BoardUI.
 *
 * The panel is built around one fact the operator has to see immediately:
 * **the free half needs no key at all**. shadcn is free outright and most of
 * BoardUI is too, so the licence field is an unlock for the Pro items, never a
 * gate on the feature. A panel that opened with "enter your key" would say the
 * opposite of what is true.
 *
 * No secret ever comes back from Main: the licence shows as a masked tail and a
 * registry token only as "stored".
 */

const KIT_LABELS: Record<UiKitIdValue, string> = {
  shadcn: 'shadcn/ui',
  boardui: 'BoardUI',
};

const TIER_LABELS: Record<string, string> = {
  free: 'grátis',
  pro: 'Pro',
  unknown: '—',
};

/**
 * The one line that says what happened. Exit code 0 used to read as
 * "Instalado" even when every file already existed and nothing was written.
 */
function installHeadline(result: UiKitInstallView): string {
  if (result.refusal === 'components_json_missing') {
    return 'Este projeto ainda não tem components.json: rode o init do shadcn primeiro, ou instale pelo BoardUI.';
  }
  if (result.refusal === 'framework_unsupported') {
    return 'Este projeto não é React para web: os kits instalam componentes React. Use o port do framework ou escreva com o contrato de design.';
  }
  if (result.refusal === 'project_busy') {
    return 'Outra instalação de kit ainda está rodando neste projeto. Espere terminar e tente de novo.';
  }
  if (!result.ok) return result.error ?? 'A instalação falhou.';
  if (result.nothingWritten) {
    return 'Nada novo: os arquivos já existiam e não foram sobrescritos.';
  }
  return `Instalado: ${result.installed.join(', ') || 'nada a fazer'}`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UiKitSection() {
  const [status, setStatus] = useState<UiKitStatusView | null>(null);
  const [kit, setKit] = useState<UiKitIdValue>('shadcn');
  const [catalog, setCatalog] = useState<UiKitCatalogView | null>(null);
  const [query, setQuery] = useState('');
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [licenseKey, setLicenseKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [registryNamespace, setRegistryNamespace] = useState('');
  const [registryUrl, setRegistryUrl] = useState('');
  const [registryToken, setRegistryToken] = useState('');
  // The SHAPE of the credential, for a registry that does not take
  // `Authorization: Bearer`. Empty name = the default contract, which is what
  // almost every registry wants; Main derives the variable either way.
  const [registryAuthKind, setRegistryAuthKind] = useState<'header' | 'param'>('header');
  const [registryAuthName, setRegistryAuthName] = useState('');
  const [registryAuthScheme, setRegistryAuthScheme] = useState<'bearer' | 'raw'>('bearer');
  const [exactSlug, setExactSlug] = useState('');
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [result, setResult] = useState<UiKitInstallView | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.nexus.uiKit.status());
    } catch {
      setStatus(null);
    }
  }, []);

  /**
   * The catalogue request in flight. The reply can take a vendor round trip,
   * so switching kits — or typing another search — while one is outstanding
   * let the OLDER reply land last: the list showed the previous kit's items
   * under the new kit's label, and clicking Install submitted an old slug
   * with the new `kit`, installing the wrong component or failing for a
   * reason that made no sense.
   */
  const catalogRequest = useRef(0);
  /** The selection as it stands now, for work that outlives its own closure. */
  const selection = useRef({ kit, query });
  useEffect(() => {
    selection.current = { kit, query };
  }, [kit, query]);

  const loadCatalog = useCallback(
    async (target: UiKitIdValue, search: string) => {
      const ticket = (catalogRequest.current += 1);
      const current = () => catalogRequest.current === ticket;
      setLoadingCatalog(true);
      try {
        const view = await window.nexus.uiKit.catalog({
          kit: target,
          ...(search.trim() ? { query: search.trim() } : {}),
        });
        if (current()) setCatalog(view);
      } catch {
        if (current()) {
          setCatalog({ kit: target, items: [], bestEffort: false, error: 'falhou' });
        }
      } finally {
        // Only the newest request owns the spinner: an older one finishing
        // would otherwise clear it while the current load is still running.
        if (current()) setLoadingCatalog(false);
      }
    },
    [],
  );

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    void loadCatalog(kit, '');
  }, [kit, loadCatalog]);

  async function saveLicense() {
    const key = licenseKey.trim();
    if (!key) return;
    setBusy('license');
    try {
      const view = await window.nexus.uiKit.license({ action: 'set', key });
      // Only when Main confirms it was stored. The vault can refuse (locked
      // keychain, denied backend) and answer `stored: false` with the reason —
      // clearing the field anyway made the operator re-enter a purchased key
      // that was never saved.
      if (view.stored) setLicenseKey('');
      setStatus((prev) => (prev ? { ...prev, license: view } : prev));
      // The refresh REPLACED the vault's reason with the generic status — "abra
      // um projeto para checar a licença" with no project open — so the
      // operator never learned why the key was not stored. On failure the
      // answer from Main is the last word; on success the refresh brings the
      // state the vendor reports.
      if (view.stored) await refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function activateLicense() {
    setBusy('license');
    try {
      const view = await window.nexus.uiKit.license({ action: 'activate' });
      setStatus((prev) => (prev ? { ...prev, license: view } : prev));
      // Same rule as saving: on failure the answer from Main is the last word.
      // The activation refuses for LOCAL reasons — the native licence file is
      // unreadable, belongs to this machine, or cannot be written — and the
      // refresh replaced that with the vendor's generic status, so the
      // operator could not tell what to fix.
      if (view.state === 'active') await refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function removeLicense() {
    setBusy('license');
    try {
      await window.nexus.uiKit.license({ action: 'remove' });
      await refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function install(request: { items?: string[]; recipe?: string }) {
    setBusy(request.recipe ?? request.items?.join(',') ?? 'install');
    setResult(null);
    try {
      // The install targets the kit the operator CLICKED for — honouring that
      // is the point. The refresh afterwards must follow the kit that is
      // selected NOW: this closure captured `kit`, so switching kits during
      // an install started a newer request for the OLD kit, whose newer
      // ticket then beat the superseded-request guard and repainted the list
      // under the new kit's label.
      const view = await window.nexus.uiKit.install({ kit, ...request });
      setResult(view);
      const now = selection.current;
      await Promise.all([refreshStatus(), loadCatalog(now.kit, now.query)]);
      return view;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Without this the panel only LISTED registries and nothing could add one —
   * so an operator told "Settings → UI kits" by a `missingRegistryKeys` hint
   * arrived at a page with no way in.
   */
  async function saveRegistry() {
    const namespace = registryNamespace.trim();
    const url = registryUrl.trim();
    if (!namespace || !url) return;
    setBusy('registry');
    setRegistryError(null);
    try {
      const authName = registryAuthName.trim();
      const next = await window.nexus.uiKit.registry({
        action: 'set',
        registry: {
          namespace,
          url,
          // Only when the operator states one: an `X-API-Key` header, a raw
          // scheme, a query parameter. Without it Main derives the default
          // Bearer contract, as before.
          ...(authName
            ? {
                auth: {
                  kind: registryAuthKind,
                  name: authName,
                  ...(registryAuthKind === 'header'
                    ? { scheme: registryAuthScheme }
                    : {}),
                },
              }
            : {}),
        },
        ...(registryToken.trim() ? { token: registryToken.trim() } : {}),
      });
      setStatus(next);
      // THE RECEIPT, not the list. Presence of the namespace was never a
      // success signal: an exception in validation or persistence returns the
      // previous list with that namespace still in it, and a namespace whose
      // shape ships with Nexus is in the effective list even when nothing was
      // written. Main now says outright what it saved.
      const saved = !next.registryError && next.registrySaved === namespace;
      if (saved) {
        setRegistryNamespace('');
        setRegistryUrl('');
        setRegistryToken('');
        setRegistryAuthKind('header');
        setRegistryAuthName('');
        setRegistryAuthScheme('bearer');
      } else {
        // Main refuses a URL that is not https, carries credentials, or has no
        // {name} placeholder — and it answers with the list it already had.
        setRegistryError(
          next.registryError ??
            'Não foi possível salvar. A URL precisa ser https, conter {name} e não levar usuário/senha.',
        );
      }
    } finally {
      setBusy(null);
    }
  }

  async function removeRegistry(namespace: string) {
    setBusy(`registry:${namespace}`);
    setRegistryError(null);
    try {
      const next = await window.nexus.uiKit.registry({ action: 'remove', namespace });
      setStatus(next);
      // The Main keeps the row when the vault refuses to clear the token —
      // otherwise the panel would report the registry gone with its credential
      // still stored. Saying so is the other half of that: without it the row
      // just stayed on screen and nothing explained why.
      if (next.registryError) setRegistryError(next.registryError);
    } finally {
      setBusy(null);
    }
  }

  async function clearCache() {
    setBusy('cache');
    try {
      setStatus(await window.nexus.uiKit.cacheClear({ kit }));
    } finally {
      setBusy(null);
    }
  }

  const license = status?.license;
  const licenseChip =
    license?.state === 'active'
      ? { label: 'Pro ativo', className: 'settings-chip settings-chip--ok' }
      : license?.stored
        ? { label: 'chave guardada', className: 'settings-chip' }
        : license?.operatorKey
          ? // A key ships with this Nexus: Pro works, the panel just
            // must not say "sem chave".
            { label: 'chave do Nexus', className: 'settings-chip settings-chip--ok' }
          : { label: 'sem chave', className: 'settings-chip' };

  return (
    <section aria-labelledby="ui-kit-heading">
      <header>
        <SettingsSectionTitle subtitle="Componentes, blocos e dashboards prontos">
          <span id="ui-kit-heading">Kits de UI</span>
        </SettingsSectionTitle>
        <p className="settings-help">
          Dois kits à disposição dos seus projetos. Instale o componente em vez
          de escrevê-lo: o item do fornecedor traz teclado, foco, ARIA e
          estados. Depois pinte com o contrato de design do projeto — o código é
          do kit, o visual é seu.
        </p>
      </header>

      {status && !status.workspaceOpen && (
        <div className="mkt-notice" role="status">
          <p>
            Abra um projeto para instalar itens. O catálogo e a chave podem ser
            configurados agora.
          </p>
        </div>
      )}

      <div className="settings-list">
        <div className="settings-list__item">
          <div className="settings-list__head">
            <span className="settings-list__title">{KIT_LABELS.shadcn}</span>
            <span className="settings-chip settings-chip--ok">sem chave</span>
          </div>
          <p className="settings-list__detail">
            Primitivos, formulários, diálogos, tabelas, sidebars, auth, blocos
            de marketing e gráficos. Gratuito, e aceita qualquer registry.
          </p>
        </div>

        <div className="settings-list__item">
          <div className="settings-list__head">
            <span className="settings-list__title">{KIT_LABELS.boardui}</span>
            <span className={licenseChip.className}>{licenseChip.label}</span>
            {license?.masked && <span className="settings-chip">{license.masked}</span>}
          </div>
          <p className="settings-list__detail">
            Superfícies de agente e dashboards: composers de chat, stat cards,
            gráficos e templates inteiros.{' '}
            {typeof status?.freeItemCount === 'number'
              ? `${status.freeItemCount} itens funcionam sem chave nenhuma. Os itens Pro (templates e componentes mais ricos) precisam da sua licença.`
              : 'A metade grátis funciona sem chave nenhuma.'}
          </p>
          <div className="settings-row">
            <input
              className="settings-input"
              type="password"
              autoComplete="off"
              value={licenseKey}
              placeholder="Chave de licença do BoardUI (opcional)"
              aria-label="Chave de licença do BoardUI"
              onChange={(event) => setLicenseKey(event.target.value)}
            />
            <button
              type="button"
              className="settings-btn"
              disabled={busy === 'license' || licenseKey.trim().length === 0}
              onClick={() => void saveLicense()}
            >
              {busy === 'license' ? 'Salvando…' : 'Salvar e ativar'}
            </button>
            {(license?.stored || license?.operatorKey) &&
              license.state !== 'active' &&
              status?.workspaceOpen && (
                // A key saved before a project was open was never activated.
                // Finishing it must not mean pasting it again; when the vault
                // is empty the key that ships with Nexus covers the click.
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy === 'license'}
                  onClick={() => void activateLicense()}
                >
                  {busy === 'license'
                    ? 'Ativando…'
                    : license.operatorKey && !license.stored
                      ? 'Ativar a chave do Nexus'
                      : 'Ativar a chave guardada'}
                </button>
              )}
            {(license?.stored || license?.state === 'active') && (
              // Also when `stored` is false: the vendor may still hold the
              // activation, and hiding this button would strand it.
              <button
                type="button"
                className="settings-btn"
                disabled={busy === 'license'}
                onClick={() => void removeLicense()}
              >
                Remover
              </button>
            )}
          </div>
          {license?.detail && <p className="settings-list__detail">{license.detail}</p>}
        </div>
      </div>

      <h3 className="settings-subheading">Montar de uma vez</h3>
      <p className="settings-help">
        Um admin não é um componente: é shell, sidebar, visão geral com
        gráficos, tabela, auth e ajustes. Cada receita resolve esses papéis
        contra o catálogo ao vivo e instala o conjunto.
      </p>
      <div className="settings-row">
        {(['shadcn', 'boardui'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="settings-btn"
            aria-pressed={kit === candidate}
            onClick={() => setKit(candidate)}
          >
            {KIT_LABELS[candidate]}
          </button>
        ))}
      </div>
      <ul className="settings-list">
        {(status?.recipes ?? []).map((recipe) => (
          <li key={recipe.id} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title">{recipe.label}</span>
              <span className="settings-chip">{recipe.roles.length} peças</span>
            </div>
            <p className="settings-list__detail">{recipe.description}</p>
            <div className="settings-row">
              <button
                type="button"
                className="settings-btn"
                disabled={!status?.workspaceOpen || busy !== null}
                onClick={() => void install({ recipe: recipe.id })}
              >
                {busy === recipe.id ? 'Instalando…' : `Instalar em ${KIT_LABELS[kit]}`}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {result && (
        <div
          className={result.ok ? 'mkt-notice mkt-notice--ok' : 'mkt-notice mkt-notice--danger'}
          role="status"
        >
          <p>{installHeadline(result)}</p>
          {result.warning && <p className="settings-list__detail">{result.warning}</p>}
          {result.files && result.files.created.length + result.files.updated.length > 0 && (
            <p className="settings-list__detail">
              Arquivos: {[...result.files.created, ...result.files.updated].slice(0, 12).join(', ')}
            </p>
          )}
          {!result.ok && result.output && (
            // The CAUSE. A dependency conflict or a network error leaves the
            // diagnosis in `output` and no `error` at all, so the panel said
            // only "a instalação falhou" and threw away the one text that
            // says what to do about it.
            <pre className="settings-pre" aria-label="Saída da instalação">
              {result.output.slice(-4000)}
            </pre>
          )}
          {result.unresolved && result.unresolved.length > 0 && (
            <p>Sem item no catálogo para: {result.unresolved.join(', ')}</p>
          )}
          {result.needsLicense && result.needsLicense.length > 0 && (
            // Reaches here from two places — uma receita cujo papel só casou
            // com item Pro, e uma instalação direta que o portão recusou — e
            // o texto tem de valer para as duas.
            <p>
              {result.licenseState === 'unknown'
                ? `Precisa da licença do BoardUI para: ${result.needsLicense.join(', ')} — não deu para confirmar a chave com o fornecedor agora.`
                : `Precisa da licença do BoardUI para: ${result.needsLicense.join(', ')} — guarde a chave acima para usá-los; os itens grátis não pedem chave.`}
            </p>
          )}
          {result.missingRegistryKeys && result.missingRegistryKeys.length > 0 && (
            <p>Sem token guardado para: {result.missingRegistryKeys.join(', ')}</p>
          )}
        </div>
      )}

      <h3 className="settings-subheading">Catálogo de {KIT_LABELS[kit]}</h3>
      <div className="settings-row" role="search">
        <input
          className="settings-input"
          type="search"
          value={query}
          placeholder="Buscar item…"
          aria-label={`Buscar item em ${KIT_LABELS[kit]}`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void loadCatalog(kit, query);
          }}
        />
        <button
          type="button"
          className="settings-btn"
          disabled={loadingCatalog}
          onClick={() => void loadCatalog(kit, query)}
        >
          {loadingCatalog ? 'Buscando…' : 'Buscar'}
        </button>
      </div>

      {catalog?.error && (
        <div className="mkt-notice mkt-notice--danger" role="alert">
          <p>{catalog.error}</p>
        </div>
      )}
      {catalog?.unmappedRegistries && catalog.unmappedRegistries.length > 0 && (
        // A silent empty list was the whole problem: o registry está guardado
        // aqui, mas o PROJETO não o declara, então a busca não o alcança e o
        // token é retido. Instalar um item dele declara o namespace.
        <p className="settings-help">
          O projeto ainda não declara {catalog.unmappedRegistries.join(', ')} no{' '}
          <code>components.json</code>, então a busca não alcança esse registry
          e o token dele fica retido. Instale um item pelo nome exato no campo
          abaixo (<code>{catalog.unmappedRegistries[0]}/algum-item</code>) para
          o Nexus declarar o namespace no projeto.
        </p>
      )}
      <div className="settings-row">
        {/*
          O aviso acima mandava instalar pelo nome exato e não havia controle
          que fizesse isso: o único Instalar do painel vive na lista do
          catálogo, e um registry não mapeado não produz item nenhum nela.
        */}
        <input
          className="settings-input"
          value={exactSlug}
          placeholder="@meukit/algum-item"
          aria-label="Instalar item pelo nome exato"
          onChange={(event) => setExactSlug(event.target.value)}
        />
        <button
          type="button"
          className="settings-btn"
          disabled={
            !status?.workspaceOpen ||
            busy !== null ||
            exactSlug.trim().length === 0
          }
          onClick={() => {
            const slug = exactSlug.trim();
            // Cleared only when it took: losing what the operator typed on a
            // failure would make them retype the item to read the error.
            void install({ items: [slug] }).then((view) => {
              if (view?.ok) setExactSlug('');
            });
          }}
        >
          {busy === exactSlug.trim() ? 'Instalando…' : 'Instalar pelo nome'}
        </button>
      </div>
      {catalog?.bestEffort && catalog.items.length === 0 && !loadingCatalog && (
        <p className="settings-help">
          Nada veio na leitura da lista, e esta CLI respondeu em texto em vez
          de JSON — então isso não prova que o registry está vazio. Procure
          pelo nome exato do item.
        </p>
      )}
      <ul className="settings-list">
        {(catalog?.items ?? []).slice(0, 80).map((item) => (
          <li key={item.slug} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title">{item.label}</span>
              <span className="settings-chip">{TIER_LABELS[item.tier] ?? item.tier}</span>
              {item.cached && <span className="settings-chip">baixado</span>}
            </div>
            <p className="settings-list__detail">{item.category}</p>
            <div className="settings-row">
              <button
                type="button"
                className="settings-btn"
                disabled={
                  !status?.workspaceOpen ||
                  busy !== null ||
                  // The rendered list outlives the kit switch: the heading and
                  // the captured `kit` change at once while the OLD catalogue
                  // stays on screen until its replacement arrives. Clicking in
                  // that window installed an old slug under the new kit. The
                  // request ticket only discards late replies; it cannot make
                  // an already-painted list non-actionable.
                  loadingCatalog ||
                  catalog?.kit !== kit
                }
                onClick={() => void install({ items: [item.slug] })}
              >
                {busy === item.slug ? 'Instalando…' : 'Instalar'}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="settings-subheading">Itens baixados no Nexus</h3>
      <p className="settings-help">
        O fonte dos itens que você consultou fica guardado aqui, para o catálogo
        abrir sem rede e o agente ler um componente sem pagar uma ida ao
        fornecedor por consulta.
      </p>
      <div className="settings-row">
        <span className="settings-chip">
          {status
            ? `${status.cache[kit]?.items ?? 0} itens · ${formatBytes(status.cache[kit]?.bytes ?? 0)}`
            : '—'}
        </span>
        <button
          type="button"
          className="settings-btn"
          disabled={busy !== null}
          onClick={() => void clearCache()}
        >
          {busy === 'cache' ? 'Limpando…' : 'Limpar'}
        </button>
      </div>

      <h3 className="settings-subheading">Registries</h3>
      <p className="settings-help">
        Um kit pago que seja distribuído como registry do shadcn entra aqui: o
        namespace, a URL com <code>{'{name}'}</code> e, se for privado, o token.
        O token fica no cofre — o que vai para o <code>components.json</code> do
        projeto é só o NOME da variável.
      </p>
      {(status?.knownRegistries ?? []).length > 0 && (
        <div className="settings-row">
          {(status?.knownRegistries ?? []).map((known) => (
            <button
              key={known.namespace}
              type="button"
              className="settings-btn"
              title={`${known.note} — ${known.site}`}
              onClick={() => {
                setRegistryNamespace(known.namespace);
                setRegistryUrl(known.url);
                setRegistryError(null);
              }}
            >
              {known.configured ? `${known.label} ✓` : known.label}
            </button>
          ))}
        </div>
      )}
      <div className="settings-row">
        <input
          className="settings-input"
          value={registryNamespace}
          placeholder="@meukit"
          aria-label="Namespace do registry"
          onChange={(event) => setRegistryNamespace(event.target.value)}
        />
        <input
          className="settings-input"
          value={registryUrl}
          placeholder="https://registry.exemplo.com/r/{name}.json"
          aria-label="URL do registry"
          onChange={(event) => setRegistryUrl(event.target.value)}
        />
        <input
          className="settings-input"
          type="password"
          autoComplete="off"
          value={registryToken}
          placeholder="Token (se for privado)"
          aria-label="Token do registry"
          onChange={(event) => setRegistryToken(event.target.value)}
        />
        <button
          type="button"
          className="settings-btn"
          disabled={
            busy !== null ||
            registryNamespace.trim().length === 0 ||
            registryUrl.trim().length === 0
          }
          onClick={() => void saveRegistry()}
        >
          {busy === 'registry' ? 'Salvando…' : 'Adicionar'}
        </button>
      </div>
      <div className="settings-row">
        <p className="settings-list__detail">
          Como o token viaja (em branco = <code>Authorization: Bearer</code>):
        </p>
        <select
          className="settings-input"
          value={registryAuthKind}
          aria-label="Tipo do contrato do registry"
          onChange={(event) =>
            setRegistryAuthKind(event.target.value === 'param' ? 'param' : 'header')
          }
        >
          <option value="header">Cabeçalho</option>
          <option value="param">Parâmetro na URL</option>
        </select>
        <input
          className="settings-input"
          value={registryAuthName}
          placeholder={registryAuthKind === 'header' ? 'X-API-Key' : 'api_key'}
          aria-label="Nome do cabeçalho ou parâmetro"
          onChange={(event) => setRegistryAuthName(event.target.value)}
        />
        {registryAuthKind === 'header' && (
          <select
            className="settings-input"
            value={registryAuthScheme}
            aria-label="Prefixo do cabeçalho"
            onChange={(event) =>
              setRegistryAuthScheme(event.target.value === 'raw' ? 'raw' : 'bearer')
            }
          >
            <option value="bearer">Com prefixo Bearer</option>
            <option value="raw">Valor cru</option>
          </select>
        )}
      </div>
      {registryError && (
        <div className="mkt-notice mkt-notice--danger" role="alert">
          <p>{registryError}</p>
        </div>
      )}
      <ul className="settings-list">
        {(status?.registries ?? []).map((registry) => (
          <li key={registry.namespace} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title">{registry.namespace}</span>
              {registry.requiresToken && (
                <span
                  className={
                    registry.tokenStored || registry.operatorKey
                      ? 'settings-chip settings-chip--ok'
                      : 'settings-chip'
                  }
                >
                  {registry.tokenStored
                    ? 'token guardado'
                    : registry.operatorKey
                      ? // A token ships with this Nexus: installs work,
                        // the panel just must not say "sem token".
                        'token do Nexus'
                      : 'sem token'}
                </span>
              )}
            </div>
            <p className="settings-list__detail">{registry.url}</p>
            {registry.envVar && (
              // Sem o nome da variável o caminho "exporto na minha máquina e
              // todo Nexus dali já abre com ela" fica indescobrível.
              <p className="settings-list__detail">
                Variável: <code>{registry.envVar}</code>
                {registry.tokenStored || registry.operatorKey
                  ? ''
                  : ' — o token pode vir dela'}
              </p>
            )}
            {(registry.configured || registry.tokenStored) && (
              // An entry only the bundle provides (no settings row, no vault
              // token of the operator's own) has nothing "Remover" can take.
              <div className="settings-row">
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy !== null}
                  onClick={() => void removeRegistry(registry.namespace)}
                >
                  {busy === `registry:${registry.namespace}` ? 'Removendo…' : 'Remover'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
