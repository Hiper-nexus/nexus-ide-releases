import { useEffect, useState } from 'react';
import type { ProductFlagResolutionRow } from '../../../shared/product-api';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { EmptyState } from '../ActionCard';

/**
 * Labs — todas as feature flags do produto com switch persistido.
 * Fonte de verdade é o registry do main (desativado pelo sistema > canal > override >
 * default); aqui só se lê a resolução e se grava override via IPC. Sem uma
 * superfície destas, capability pronta atrás de flag é invisível ao operador.
 */

/** Rótulos e dicas PT-BR por flag; ids novos caem no fallback (id cru). */
export const LABS_FLAG_COPY: Record<string, { title: string; hint?: string }> = {
  'feature.mcp.sharedHub': {
    title: 'Compartilhar servidores MCP entre os painéis',
    hint:
      'Os servidores MCP do seu perfil sobem uma vez no Nexus e cada painel fala com eles por HTTP, em vez de cada painel abrir os seus (~600 MB por painel). Desligar volta ao modo antigo.',
  },
  'feature.mission.warmupAdvisories': {
    title: 'Preparar revisão durante a execução',
    hint: 'Revisores preparam uma lista de verificações enquanto a missão é implementada.',
  },
  'feature.mission.doneTeardown': {
    title: 'Liberar terminais após aprovação',
    hint: 'Fecha agentes inativos após marcar a missão como feita. O coordenador continua disponível para ajustes.',
  },
  'feature.mission.workerHandoffEnforcement': {
    title: 'Acompanhar entregas dos agentes',
    hint: 'Lembra os agentes de entregar seus resultados e registra uma entrega automática quando necessário.',
  },
  'feature.pane.nonWorkerAutoClose': {
    title: 'Liberar memória de terminais inativos',
    hint: 'Estaciona agentes auxiliares sem missão após 30 minutos inativos. Seus terminais só podem ser estacionados por falta de memória, preservando o histórico.',
  },
  'feature.pty.persistentSession': {
    title: 'Manter sessões ao fechar o app',
    hint: 'Quando disponível, usa tmux para manter agentes em execução e reconectar ao reabrir o app.',
  },
  'feature.ui.projectOverview': {
    title: 'Visão geral do projeto',
    hint: 'Mostra o objetivo e uma visão dos agentes na página Projeto.',
  },
  'feature.terminal.commandBlocks': {
    title: 'Blocos de comando no terminal',
    hint: 'Permite copiar e executar comandos novamente pelo menu do terminal. Vale para novos terminais.',
  },
  'feature.mission.eventJournal': {
    title: 'Histórico das missões',
    hint: 'Acompanhe os acontecimentos de cada missão no painel lateral.',
  },
  'feature.search.mixer': {
    title: 'Busca unificada',
    hint: 'Arquivos, missões e skills na aba Busca do painel contextual (somente leitura).',
  },
  'feature.ui.contextualPanel': {
    title: 'Painel contextual (direita)',
    hint: 'Reúne busca, instruções, editor, memória, missões e Git no painel lateral.',
  },
  'feature.editor.codemirror': {
    title: 'Editor de arquivos',
    hint: 'Abra e edite arquivos com proteção contra alterações simultâneas.',
  },
  'feature.mcp.hub': {
    title: 'Compartilhar conexões de ferramentas',
    hint: 'Atualiza as configurações de outras ferramentas de IA após prévia e confirmação, com cópia de segurança.',
  },
  'feature.skills.catalog': {
    title: 'Catálogo de skills',
    hint: 'Lista skills do workspace (.claude/.nexus) na aba Skills.',
  },
  'feature.memory.nexusMemory': {
    title: 'Notas em Markdown',
    hint: 'Cópia legível das notas deste workspace, guardada no app (não no repositório).',
  },
  'feature.memory.workspaceMemory': {
    title: 'Memória do projeto',
    hint: 'Caderno deste workspace. Agentes podem buscar; o painel Memória lista e grava as notas.',
  },
  'feature.autonomy.profiles': {
    title: 'Perfis de autonomia',
    hint: 'Ainda sem efeito na interface.',
  },
  'feature.remote.relayTransport': {
    title: 'Acesso pelo celular',
    hint: 'Conecte o celular com criptografia de ponta a ponta. Exige configurar um servidor de conexão próprio.',
  },
  'orch.parallelScheduler': {
    title: 'Execução paralela de missões',
    hint: 'Distribui tarefas em cópias isoladas do projeto após aprovar a missão e o plano.',
  },
  'feature.mission.workerHandoffTtl': {
    title: 'Fechar agentes que terminaram',
    hint: 'Fecha o terminal de um agente inativo cerca de 30 segundos após a entrega ser recebida. Novo trabalho cancela o fechamento.',
  },
};

export function describeFlagReason(reason: string): string {
  switch (reason) {
    case 'override':
      return 'escolha personalizada';
    case 'default':
      return 'padrão do app';
    case 'kill-switch':
      return 'desativado pelo sistema';
    case 'channel-blocked':
      return 'indisponível nesta versão';
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

function reasonModifier(reason: string): string {
  if (reason === 'override') return ' labs-flag__reason--override';
  if (reason === 'kill-switch') return ' labs-flag__reason--blocked';
  if (reason === 'channel-blocked') return ' labs-flag__reason--unavailable';
  return '';
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
    <div
      className={`ops-consent-panel labs-flag${killed ? ' labs-flag--killed' : ''}`}
      data-flag-id={row.id}
    >
      <div>
        <p className="ops-consent-panel__title">{copy?.title ?? row.id}</p>
        <p className="ops-consent-panel__copy">
          {copy?.hint ?? 'Recurso experimental.'}
        </p>
        <p className="labs-flag__meta">
          <span className={`labs-flag__reason${reasonModifier(row.reason)}`}>
            {describeFlagReason(row.reason)}
          </span>
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
        </p>
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
          {pending
            ? 'salvando'
            : killed
              ? 'bloqueada'
              : row.enabled
                ? 'ligada'
                : 'desligada'}
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

  const enabledCount = rows?.filter((row) => row.enabled).length ?? 0;
  const overrideCount =
    rows?.filter((row) => row.reason === 'override').length ?? 0;
  const blockedCount =
    rows?.filter(
      (row) =>
        row.reason === 'kill-switch' ||
        row.reason === 'channel-blocked' ||
        definitionKillSwitch(row.definition),
    ).length ?? 0;

  return (
    <section className="sys-section">
      <SettingsSectionTitle>Experimental</SettingsSectionTitle>
      <p className="ops-consent-panel__copy">
        Experimente recursos em desenvolvimento. Algumas mudanças exigem
        abrir um novo terminal ou reiniciar o app.
      </p>
      {error ? <p className="labs-flags__error" role="alert">{error}</p> : null}
      {rows === null ? (
        <div
          className="settings-skeleton"
          role="status"
          aria-label="Carregando recursos"
        >
          <span />
          <span />
          <span />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="sparkle"
          title="Nenhum recurso experimental"
          body={
            <p>
              Esta versão não traz recursos sob flag. Novidades em teste
              aparecem aqui.
            </p>
          }
        />
      ) : (
        <>
          <div className="sys-stat-strip" aria-label="Resumo dos recursos">
            <span className="settings-chip">{rows.length} recursos</span>
            <span className="settings-chip">{enabledCount} ligados</span>
            {overrideCount > 0 && (
              <span className="labs-flag__reason labs-flag__reason--override">
                {overrideCount} personalizados
              </span>
            )}
            {blockedCount > 0 && (
              <span className="labs-flag__reason labs-flag__reason--blocked">
                {blockedCount} bloqueados
              </span>
            )}
          </div>
          {rows.map((row) => (
            <FlagRow
              key={row.id}
              row={row}
              pending={pending.has(row.id)}
              onToggle={(id, next) => void apply(id, next)}
              onReset={(id) => void apply(id, null)}
            />
          ))}
        </>
      )}
    </section>
  );
}
