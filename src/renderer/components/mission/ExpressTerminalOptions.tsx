import { ActionCard } from '../ActionCard';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useTerminalGridDialogStore } from '../../state/terminal-grid-dialog-store';
import { usePaneScopeStore } from '../../state/pane-scope-store';
import { LOOSE_SCOPE_KEY } from '../../lib/pane-spaces';
import { launcherShortcutHint } from '../../lib/action-names';
import { reportLicenseDenial } from '../../state/access-guard';

/** Grade de terminais do início (atalho 1 e o cartão da tela Expresso). */
export function openExpressTerminalGrid(): void {
  useTerminalGridDialogStore.getState().open({ initialCount: 2 });
}

/** Terminal só com shell (atalho 4). Navegar e criar, nesta ordem. */
export function openExpressBareShell(): void {
  useProductNavigationStore.getState().openTerminal();
  try {
    useLayoutStore.getState().addShellPane();
  } catch (error) {
    if (!reportLicenseDenial(error)) throw error;
    return;
  }
  usePaneScopeStore.getState().focusScope(LOOSE_SCOPE_KEY);
}

/**
 * O caminho manual da tela de criação: abrir os próprios painéis em vez de
 * deixar o Nexus montar a equipe.
 *
 * Existe porque a capacidade foi PERDIDA, não porque faltou: o antigo
 * `product/Launcher.tsx` (código morto, removido no F-1174) tinha esta mesma seção com estas
 * mesmas duas portas, e o `pane-picker-store.requestOpen()` ficou órfão — o
 * docstring dele ainda aponta para um "Início → Abrir um pane" que não existe
 * mais na árvore. Sem isto, o operador tinha que sair para Terminais só para
 * achar um terminal.
 *
 * As duas ações chamam as stores DIRETO, em vez de receber props: assim a
 * assinatura de `ExpressMissionStart` não muda, e o mock de
 * `MissionSetup.home.test.tsx` (que substitui aquele componente com uma lista
 * fixa de props) continua válido.
 */
export function ExpressTerminalOptions(): React.JSX.Element {
  return (
    <section
      className="mission-setup__terminal-options"
      aria-labelledby="express-terminal-title"
    >
      {/* Cabeçalho de seção da própria tela (`.mission-setup__section-heading`
          já tem variante para o Expresso) — nada de classe nova de título. */}
      <div className="mission-setup__section-heading">
        <div>
          <h2 id="express-terminal-title">Prefere trabalhar nos terminais?</h2>
          <p className="mission-setup__hint">
            Abra seus próprios painéis e escolha uma ferramenta para cada um.
          </p>
        </div>
      </div>
      <div className="mission-setup__terminal-actions">
        <ActionCard
          icon="grid"
          size="sm"
          variant="ghost"
          title="Montar meus terminais"
          subtitle="Escolha a pasta, a quantidade de painéis e as IAs."
          data-launcher-action="pane"
          shortcut={launcherShortcutHint('pane') ?? undefined}
          onClick={openExpressTerminalGrid}
        />
        <ActionCard
          icon="terminal"
          size="sm"
          variant="ghost"
          title="Terminal sem IA"
          subtitle="Use comandos diretamente, sem assistente."
          data-launcher-action="shell"
          shortcut={launcherShortcutHint('shell') ?? undefined}
          onClick={openExpressBareShell}
        />
        <ActionCard
          icon="board"
          size="sm"
          variant="ghost"
          title="Missões e tarefas"
          subtitle="Veja o que falta e o que já foi entregue."
          data-launcher-action="tasks"
          shortcut={launcherShortcutHint('tasks') ?? undefined}
          onClick={() => useProductNavigationStore.getState().openTaskBoard()}
        />
        <ActionCard
          icon="files"
          size="sm"
          variant="ghost"
          title="Memória do projeto"
          subtitle="Preferências e notas que atravessam sessões."
          data-launcher-action="memory"
          shortcut={launcherShortcutHint('memory') ?? undefined}
          onClick={() => useProductNavigationStore.getState().openMemory()}
        />
      </div>
    </section>
  );
}
