/**
 * BYOH / ACP harness configuration. Backed by orch settings (save + probe
 * via orchSet/orchGet) — only shown when the ACP driver modules are present
 * in this build (always, post-foundation) and the operator opts into the
 * transport. Every control has a real action and error feedback.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OrchSettings } from '../../../shared/settings-types';
import { PRESET_HARNESSES } from '../../../shared/harness-catalog';
import { PixelIcon } from '../PixelIcon';

type ProbeState = OrchSettings['acpHarnessLastProbe'];

async function loadOrch(): Promise<OrchSettings> {
  return window.nexus.settings.orchGet();
}

async function patchOrch(patch: Partial<OrchSettings>): Promise<OrchSettings> {
  return window.nexus.settings.orchSet(patch);
}

export function AcpHarnessPanel() {
  const [orch, setOrch] = useState<OrchSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [customJson, setCustomJson] = useState(
    '{\n  "id": "meu-agente",\n  "label": "Meu agente ACP",\n  "command": "meu-agente-acp",\n  "args": []\n}',
  );
  const [probePendingId, setProbePendingId] = useState<string | null>(null);
  const [probePendingHarnessId, setProbePendingHarnessId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setOrch(await loadOrch());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!probePendingId || !orch?.acpHarnessLastProbe) return;
    if (orch.acpHarnessLastProbe.requestId === probePendingId) {
      setProbePendingId(null);
      setProbePendingHarnessId(null);
      setBusy(false);
    }
  }, [orch, probePendingId]);

  useEffect(() => {
    if (!probePendingId) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 400);
    return () => window.clearInterval(timer);
  }, [probePendingId, refresh]);

  const customs = orch?.acpCustomHarnesses ?? [];
  const selectedId = orch?.acpHarnessId ?? '';
  const transport = orch?.agentTransport ?? 'cli-pty';
  const lastProbe: ProbeState = orch?.acpHarnessLastProbe ?? null;

  const catalog = useMemo(
    () => [
      ...PRESET_HARNESSES.map((h) => ({
        id: h.id,
        label: h.label,
        tier: h.tier,
        command: h.command,
      })),
      ...customs.map((raw) => ({
        id: String(raw.id ?? ''),
        label: String(raw.label ?? raw.id ?? ''),
        tier: 'custom' as const,
        command: String(raw.command ?? ''),
      })),
    ],
    [customs],
  );

  async function setTransport(next: 'cli-pty' | 'acp') {
    setBusy(true);
    setError(null);
    try {
      setOrch(await patchOrch({ agentTransport: next }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function selectHarness(id: string) {
    setBusy(true);
    setError(null);
    try {
      setOrch(await patchOrch({ acpHarnessId: id }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveCustom() {
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(customJson) as Record<string, unknown>;
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      if (!id) throw new Error('A definição precisa de um identificador no campo id.');
      const nextCustoms = [
        ...customs.filter((entry) => entry.id !== id),
        parsed,
      ];
      setOrch(
        await patchOrch({
          acpCustomHarnesses: nextCustoms,
          acpHarnessId: id,
          agentTransport: 'acp',
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'JSON inválido. Revise a definição e salve novamente.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeCustom(id: string) {
    setBusy(true);
    setError(null);
    try {
      const nextCustoms = customs.filter((entry) => entry.id !== id);
      setOrch(
        await patchOrch({
          acpCustomHarnesses: nextCustoms,
          acpHarnessId: selectedId === id ? '' : selectedId,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(id: string) {
    const requestId = `probe-${Date.now()}`;
    setBusy(true);
    setError(null);
    setProbePendingId(requestId);
    setProbePendingHarnessId(id);
    try {
      setOrch(
        await patchOrch({
          acpHarnessProbeRequest: { id, requestId },
        }),
      );
    } catch (cause) {
      setProbePendingId(null);
      setProbePendingHarnessId(null);
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!orch) {
    return (
      <div className="acp-harness">
        {error ? <div className="harness-settings__error" role="alert">
          <p>Não foi possível carregar a configuração: {error}</p>
          <button type="button" className="settings-btn" onClick={() => void refresh()}>Tentar novamente</button>
        </div> : <p role="status">Carregando conexão dos agentes…</p>}
      </div>
    );
  }

  return (
    <section className="acp-harness" aria-label="Conexão de agentes ACP">
      <header className="acp-harness__header">
        <h3>Como o Nexus abre seus agentes</h3>
        <p>
          Use o terminal da ferramenta no dia a dia. A conexão ACP é uma opção
          avançada para agentes que oferecem comunicação direta com o Nexus.
        </p>
      </header>

      <div className="acp-harness__transport" role="group" aria-label="Forma de abrir agentes">
        <button
          type="button"
          className={transport === 'cli-pty' ? 'is-active' : undefined}
          disabled={busy}
          onClick={() => void setTransport('cli-pty')}
          aria-pressed={transport === 'cli-pty'}
        >
          Terminal da ferramenta
        </button>
        <button
          type="button"
          className={transport === 'acp' ? 'is-active' : undefined}
          disabled={busy}
          onClick={() => void setTransport('acp')}
          aria-pressed={transport === 'acp'}
        >
          Conexão ACP
        </button>
      </div>

      {transport === 'acp' && (
        <p className="acp-harness__status" role="status">
          {selectedId
            ? `Agente escolhido: ${catalog.find((row) => row.id === selectedId)?.label ?? selectedId}`
            : 'Escolha um agente abaixo para usar a conexão ACP.'}
        </p>
      )}

      {transport === 'acp' && (
        <>
          <p className="acp-harness__explanation">O agente precisa estar instalado e responder ao teste. Se a conexão ACP falhar, o Nexus informa o erro; não troca automaticamente para um terminal.</p>
          <ul className="acp-harness__list">
            {catalog.map((row) => (
              <li key={row.id}>
                <div>
                  <strong>{row.label || row.id}</strong>
                  <span>
                    {row.tier === 'custom' ? 'Personalizado' : 'Modelo de configuração'}
                  </span>
                  <details><summary>Comando de inicialização</summary><code>{row.command}</code></details>
                </div>
                <div className="acp-harness__actions">
                  <button
                    type="button"
                    disabled={busy}
                    aria-pressed={selectedId === row.id}
                    onClick={() => void selectHarness(row.id)}
                    title="Usar este agente"
                    aria-label={`${selectedId === row.id ? 'Agente escolhido' : 'Selecionar agente'}: ${row.label}`}
                  >
                    {selectedId === row.id ? 'Escolhido' : 'Selecionar'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void testConnection(row.id)}
                    title="Testar conexão deste agente"
                    aria-label={`Testar conexão de ${row.label}`}
                  >
                    <PixelIcon name="sparkle" size={10} />
                    {probePendingHarnessId === row.id ? 'Testando…' : 'Testar'}
                  </button>
                  {row.tier === 'custom' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeCustom(row.id)}
                      title="Remover agente personalizado"
                      aria-label={`Remover ${row.label}`}
                    >
                      Remover
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <details className="acp-harness__custom">
          <summary>Adicionar agente personalizado</summary>
          <p>Para integrações próprias. Salvar seleciona esta definição e ativa a conexão ACP.</p>
          <label className="acp-harness__editor">
            <span>Definição do agente (JSON)</span>
            <textarea
              value={customJson}
              onChange={(event) => setCustomJson(event.target.value)}
              rows={8}
              spellCheck={false}
              aria-label="JSON do harness custom"
            />
          </label>
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            disabled={busy}
            onClick={() => void saveCustom()}
          >
            Salvar e usar definição
          </button>
          </details>
        </>
      )}

      {lastProbe && (
        <p
          className={
            lastProbe.ok ? 'acp-harness__probe ok' : 'acp-harness__probe err'
          }
          role="status"
        >
          Último teste de {catalog.find(row => row.id === lastProbe.harnessId)?.label ?? lastProbe.harnessId}: {lastProbe.ok ? 'conexão confirmada' : 'não conectou'}. {lastProbe.detail}
        </p>
      )}
      {error && (
        <p className="acp-harness__probe err" role="alert">
          {error}. Revise a configuração e tente novamente.
        </p>
      )}
    </section>
  );
}
