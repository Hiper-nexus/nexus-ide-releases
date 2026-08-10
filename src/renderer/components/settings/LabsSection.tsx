import { useEffect, useState } from 'react';
import type { ProductFlagResolutionRow } from '../../../shared/product-api';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Labs — todas as feature flags do produto com switch persistido.
 * Fonte de verdade é o registry do main (kill switch > canal > override >
 * default); aqui só se lê a resolução e se grava override via IPC. Sem uma
 * superfície destas, capability pronta atrás de flag é invisível ao operador.
 */

/** Rótulos e dicas PT-BR por flag; ids novos caem no fallback (id cru). */
export const LABS_FLAG_COPY: Record<string, { title: string; hint?: string }> = {
  'feature.terminal.commandBlocks': {
    title: 'Blocos de comando no terminal',
    hint: 'Integração OSC 133 no shell de novos terminais (menu "Cmds": copiar, re-executar, cwd).',
  },
  'feature.mission.eventJournal': {
    title: 'Journal de eventos de missão',
    hint: 'Registro append-only com replay/ACK na aba Missão do painel contextual.',
  },
  'feature.search.mixer': {
    title: 'Busca unificada',
    hint: 'Arquivos, missões e skills na aba Busca do painel contextual (somente leitura).',
  },
  'feature.ui.contextualPanel': {
    title: 'Painel contextual (direita)',
    hint: 'Guarda-chuva das abas Busca/Skills/Editor/Memória/Missão/Git — Alt+] alterna.',
  },
  'feature.editor.codemirror': {
    title: 'Editor de workspace',
    hint: 'Abrir/editar arquivo com guarda de hash (UI atual em textarea; CM6 pendente).',
  },
  'feature.mcp.hub': {
    title: 'MCP Hub + Across Tools sync',
    hint: 'O sync escreve configs de outras ferramentas (Cursor/Claude/Codex) no seu HOME — sempre via dry-run → confirmação → backup.',
  },
  'feature.skills.catalog': {
    title: 'Catálogo de skills',
    hint: 'Lista skills do workspace (.claude/.nexus) na aba Skills.',
  },
  'feature.memory.nexusMemory': {
    title: 'Memória Markdown (.nexus-memory/)',
    hint: 'Notas locais com wikilinks; "Lembrar" escreve arquivos no workspace.',
  },
  'feature.memory.workspaceMemory': {
    title: 'Memória agentic por workspace',
    hint: 'nexus_memory_retain/recall/stats (FTS5) compartilhada entre CLIs; abre o painel Memória na barra do workspace.',
  },
  'feature.autonomy.profiles': {
    title: 'Perfis de autonomia',
    hint: 'Backend pronto, ainda sem consumidor na UI — ligar não muda nada visível.',
  },
  'feature.remote.relayTransport': {
    title: 'Companion via relay E2E',
    hint: 'Libera a seção Companion mobile em Configurações → Sistema; exige URL wss:// de um relay hospedado (nunca usa relay público por default).',
  },
  'orch.parallelScheduler': {
    title: 'Scheduler paralelo de missões',
    hint: 'Fan-out por worktrees com MergeQueue serial; só age com missão aprovada e plano selado.',
  },
  'feature.mission.workerHandoffTtl': {
    title: 'Worker TTL pós-handoff',
    hint: 'Paridade Overclock (opt-in): worker idle com todos os handoffs consumidos fecha sozinho ~30s depois, liberando o pane. Qualquer trabalho novo cancela.',
  },
};

export function describeFlagReason(reason: string): string {
  switch (reason) {
    case 'override':
      return 'override manual';
    case 'default':
      return 'padrão do build';
    case 'kill-switch':
      return 'kill switch';
    case 'channel-blocked':
      return 'bloqueada pelo canal';
    default:
      return reason;
  }
}

function definitionKillSwitch(definition: unknown): boolean {
  return (
    typeof definition === 'object' &&
    definition !== null &&
    (definition as { killSwitch?: unknown }).killSwitch === true
  );
}

function FlagRow({
  row,
  pending,
  onToggle,
  onReset,
}: {
  row: ProductFlagResolutionRow;
  pending: boolean;
  onToggle: (id: string, next: boolean) => void;
  onReset: (id: string) => void;
}) {
  const copy = LABS_FLAG_COPY[row.id];
  const killed = definitionKillSwitch(row.definition);
  return (
    <div className="ops-consent-panel" data-flag-id={row.id}>
      <div>
        <p className="ops-consent-panel__title">{copy?.title ?? row.id}</p>
        <p className="ops-consent-panel__copy">
          <code>{row.id}</code> · {describeFlagReason(row.reason)}
          {copy?.hint ? <> — {copy.hint}</> : null}
        </p>
        {row.reason === 'override' ? (
          <button
            type="button"
            className="labs-flag__reset"
            disabled={pending}
            onClick={() => onReset(row.id)}
          >
            Restaurar padrão
          </button>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={row.enabled}
        aria-label={`Alternar ${copy?.title ?? row.id}`}
        className={`ops-switch ${row.enabled ? 'ops-switch--on' : ''}`}
        disabled={pending || killed}
        onClick={() => onToggle(row.id, !row.enabled)}
      >
        <span className="ops-switch__track">
          <span className="ops-switch__thumb" />
        </span>
        <span className="ops-switch__label">
          {pending ? 'salvando' : row.enabled ? 'ligada' : 'desligada'}
        </span>
      </button>
    </div>
  );
}

export function LabsSection() {
  const [rows, setRows] = useState<ProductFlagResolutionRow[] | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await window.nexus?.product?.flagsList();
        if (!cancelled && Array.isArray(list)) setRows(list);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    const unsubscribe = window.nexus?.product?.onFlagsChanged?.((list) => {
      if (!cancelled && Array.isArray(list)) setRows(list);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const apply = async (id: string, enabled: boolean | null) => {
    // Pending por-id: alternar B enquanto A salva não pode reabilitar o switch
    // de A nem "roubar" o rótulo salvando.
    setPending((p) => new Set(p).add(id));
    setError(null);
    try {
      const list = await window.nexus?.product?.flagsSetOverride({
        id,
        enabled,
      });
      if (Array.isArray(list)) setRows(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <section>
      <SettingsSectionTitle>Labs</SettingsSectionTitle>
      <p className="ops-consent-panel__copy">
        Toda capability do produto atrás de flag, com o estado real resolvido
        pelo main (kill switch &gt; canal &gt; override &gt; default). Mudanças
        persistem e valem na hora para painéis; o que é preparado no boot (ex.:
        integração de shell) vale para novos terminais ou após reiniciar.
      </p>
      {error ? <p className="labs-flags__error">{error}</p> : null}
      {rows === null ? (
        <p className="ops-consent-panel__copy">Carregando flags…</p>
      ) : (
        rows.map((row) => (
          <FlagRow
            key={row.id}
            row={row}
            pending={pending.has(row.id)}
            onToggle={(id, next) => void apply(id, next)}
            onReset={(id) => void apply(id, null)}
          />
        ))
      )}
    </section>
  );
}
