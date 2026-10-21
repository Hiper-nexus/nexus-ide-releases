import { useCallback, useEffect, useState } from 'react';
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
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [result, setResult] = useState<UiKitInstallView | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.nexus.uiKit.status());
    } catch {
      setStatus(null);
    }
  }, []);

  const loadCatalog = useCallback(
    async (target: UiKitIdValue, search: string) => {
      setLoadingCatalog(true);
      try {
        setCatalog(
          await window.nexus.uiKit.catalog({
            kit: target,
            ...(search.trim() ? { query: search.trim() } : {}),
          }),
        );
      } catch {
        setCatalog({ kit: target, items: [], bestEffort: false, error: 'falhou' });
      } finally {
        setLoadingCatalog(false);
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
      setLicenseKey('');
      setStatus((prev) => (prev ? { ...prev, license: view } : prev));
      await refreshStatus();
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
      setResult(await window.nexus.uiKit.install({ kit, ...request }));
      await Promise.all([refreshStatus(), loadCatalog(kit, query)]);
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
      const next = await window.nexus.uiKit.registry({
        action: 'set',
        registry: { namespace, url },
        ...(registryToken.trim() ? { token: registryToken.trim() } : {}),
      });
      setStatus(next);
      const saved = next.registries.some((entry) => entry.namespace === namespace);
      if (saved) {
        setRegistryNamespace('');
        setRegistryUrl('');
        setRegistryToken('');
      } else {
        // Main refuses a URL that is not https, carries credentials, or has no
        // {name} placeholder — and it answers with the list it already had.
        setRegistryError(
          'Não foi possível salvar. A URL precisa ser https, conter {name} e não levar usuário/senha.',
        );
      }
    } finally {
      setBusy(null);
    }
  }

  async function removeRegistry(namespace: string) {
    setBusy(`registry:${namespace}`);
    try {
      setStatus(await window.nexus.uiKit.registry({ action: 'remove', namespace }));
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
            {status
              ? `${status.freeItemCount} itens grátis funcionam sem chave nenhuma; ${status.proItemCount} são Pro.`
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
            {license?.stored && (
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
          <p>
            {result.ok
              ? `Instalado: ${result.installed.join(', ') || 'nada a fazer'}`
              : (result.error ?? 'A instalação falhou.')}
          </p>
          {result.unresolved && result.unresolved.length > 0 && (
            <p>Sem item no catálogo para: {result.unresolved.join(', ')}</p>
          )}
          {result.needsLicense && result.needsLicense.length > 0 && (
            <p>
              Só havia item Pro para: {result.needsLicense.join(', ')} — guarde a
              chave do BoardUI acima para usá-los.
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
      {catalog?.bestEffort && catalog.items.length === 0 && !loadingCatalog && (
        <p className="settings-help">
          Nada veio na leitura da lista. A CLI do shadcn não tem saída
          estruturada para busca, então isso não prova que o registry está
          vazio — procure pelo nome exato do item.
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
                disabled={!status?.workspaceOpen || busy !== null}
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
                    registry.tokenStored
                      ? 'settings-chip settings-chip--ok'
                      : 'settings-chip'
                  }
                >
                  {registry.tokenStored ? 'token guardado' : 'sem token'}
                </span>
              )}
            </div>
            <p className="settings-list__detail">{registry.url}</p>
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
          </li>
        ))}
      </ul>
    </section>
  );
}
