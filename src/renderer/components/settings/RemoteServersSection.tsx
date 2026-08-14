import { useEffect, useState } from 'react';
import type {
  RemoteSshConnectResult,
  RemoteSshHostView,
} from '../../../shared/remote-types';
import { ActionCard, EmptyState } from '../ActionCard';

const EMPTY_FORM = {
  alias: '',
  host: '',
  user: '',
  password: '',
  port: '',
};

export function RemoteServersSection({
  onHostsChange,
}: {
  onHostsChange?: (hosts: readonly RemoteSshHostView[]) => void;
} = {}) {
  const [hosts, setHosts] = useState<RemoteSshHostView[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [connecting, setConnecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const list = await window.nexus.remote.listSshHosts();
    setHosts(list);
    onHostsChange?.(list);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function connect() {
    setError(null);
    setStatus(null);
    setConnecting(true);
    const password = form.password;
    setForm((current) => ({ ...current, password: '' }));
    let result: RemoteSshConnectResult;
    try {
      result = await window.nexus.remote.connectSshHost({
        alias: form.alias.trim(),
        host: form.host.trim(),
        user: form.user.trim(),
        password,
        port: form.port.trim() ? Number(form.port) : undefined,
      });
    } finally {
      setConnecting(false);
    }
    if (!result.ok) {
      setError(result.error ?? 'Falha ao conectar. O servidor não foi marcado como conectado.');
      return;
    }
    setShowForm(false);
    setForm(EMPTY_FORM);
    setStatus(`Conectado como ${result.alias}. A senha foi descartada.`);
    await refresh();
  }

  async function detect() {
    setError(null);
    setStatus(null);
    setImporting(true);
    try {
      const result = await window.nexus.remote.importSshConfig();
      if (!result.ok) {
        setError(result.error ?? 'Não foi possível ler ~/.ssh/config.');
        return;
      }
      const names = result.imported.map((host: RemoteSshHostView) => host.alias).join(', ');
      setStatus(
        result.imported.length === 0
          ? result.skipped
            ? 'Nenhum Host novo — os apelidos já estavam na lista.'
            : 'Nenhum Host importável em ~/.ssh/config.'
          : `Importados: ${names}. A chave deles continua onde já estava.`,
      );
      await refresh();
    } finally {
      setImporting(false);
    }
  }

  async function remove(alias: string) {
    setError(null);
    const result = await window.nexus.remote.removeSshHost(alias);
    if (!result.ok) {
      setError(result.error ?? 'Não foi possível remover o apelido.');
      return;
    }
    await refresh();
  }

  const empty = hosts.length === 0 && !showForm;

  return (
    <section className="settings-card" aria-labelledby="remote-servers-title">
      <div className="settings-card__head">
        <div className="settings-card__titles">
          <h3 id="remote-servers-title" className="settings-card__title">
            Servidores
          </h3>
          <p className="settings-card__subtitle">
            Uma máquina pelo apelido: o agente roda <code>ssh vps-1</code> e o
            endereço não aparece.
          </p>
        </div>
        <div className="settings-action-row" role="group" aria-label="Ações de servidores">
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            onClick={() => {
              setShowForm(true);
              setError(null);
            }}
          >
            Conectar servidor
          </button>
          <button
            type="button"
            className="settings-btn"
            onClick={() => void detect()}
            disabled={importing}
          >
            Detectar do ~/.ssh/config
          </button>
        </div>
      </div>

      {empty ? (
        <EmptyState
          icon="key"
          title="Nenhum servidor pelo apelido"
          body={
            <ol className="remote-servers__steps">
              <li>
                <strong>Conectar</strong> — IP, usuário e senha uma vez.
              </li>
              <li>
                <strong>Chave criada</strong> — o Nexus gera uma chave só deste
                apelido e instala no servidor. A senha é jogada fora.
              </li>
              <li>
                <strong>Agente só fala o apelido</strong> — daí em diante é{' '}
                <code>ssh vps-1</code>, sem o endereço no comando.
              </li>
            </ol>
          }
          action={
            <ActionCard
              icon="plus"
              title="Conectar servidor"
              subtitle="IP + usuário + senha, uma vez"
              variant="primary"
              onClick={() => setShowForm(true)}
            />
          }
        />
      ) : null}

      {showForm ? (
        <form
          className="settings-form-grid settings-form-grid--remote"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <label className="settings-field">
            <span className="settings-field__label">Apelido</span>
            <input
              className="settings-input"
              value={form.alias}
              placeholder="vps-1"
              autoComplete="off"
              onChange={(e) => setForm((current) => ({ ...current, alias: e.target.value }))}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Endereço</span>
            <input
              className="settings-input"
              value={form.host}
              placeholder="só desta vez"
              autoComplete="off"
              onChange={(e) => setForm((current) => ({ ...current, host: e.target.value }))}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Usuário</span>
            <input
              className="settings-input"
              value={form.user}
              placeholder="ubuntu"
              autoComplete="off"
              onChange={(e) => setForm((current) => ({ ...current, user: e.target.value }))}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Senha</span>
            <input
              className="settings-input"
              type="password"
              value={form.password}
              placeholder="não é guardada"
              autoComplete="new-password"
              onChange={(e) => setForm((current) => ({ ...current, password: e.target.value }))}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field__label">Porta</span>
            <input
              className="settings-input"
              value={form.port}
              placeholder="22"
              inputMode="numeric"
              onChange={(e) => setForm((current) => ({ ...current, port: e.target.value }))}
            />
          </label>
          <div className="settings-field settings-field--wide settings-action-row">
            <button
              type="submit"
              className="settings-btn settings-btn--primary"
              disabled={
                connecting ||
                !form.alias.trim() ||
                !form.host.trim() ||
                !form.user.trim() ||
                !form.password
              }
            >
              {connecting ? 'Conectando…' : 'Conectar e criar chave'}
            </button>
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                setShowForm(false);
                setForm(EMPTY_FORM);
              }}
            >
              Cancelar
            </button>
          </div>
        </form>
      ) : null}

      {hosts.length > 0 ? (
        <ul className="settings-list" aria-label="Servidores pelo apelido">
          {hosts.map((host) => (
            <li key={host.alias} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title settings-list__title--mono">
                  {host.alias}
                </span>
                <span
                  className={`settings-chip ${
                    host.ready ? 'settings-chip--ok' : 'settings-chip--warn'
                  }`}
                >
                  {host.source === 'imported' ? 'importado' : 'nexus'}
                </span>
                <span
                  className={`settings-status-pill ${
                    host.ready ? 'settings-status-pill--ok' : 'settings-status-pill--warn'
                  }`}
                >
                  {host.ready ? 'Pronto' : 'Incompleto'}
                </span>
              </div>
              <p className="settings-list__detail">
                {host.user ? `usuário ${host.user}` : 'usuário do Host'}
                {host.hasNexusKey ? ' · chave Nexus' : ' · reusa a IdentityFile já declarada'}
                {' · '}
                <code>ssh {host.alias}</code>
              </p>
              <div className="settings-action-row">
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => void remove(host.alias)}
                >
                  Remover
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {status ? (
        <p className="settings-card__note" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
