import { ActionCard } from '../ActionCard';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useTerminalGridDialogStore } from '../../state/terminal-grid-dialog-store';
import { usePaneScopeStore } from '../../state/pane-scope-store';
import { LOOSE_SCOPE_KEY } from '../../lib/pane-spaces';
import { reportLicenseDenial } from '../../state/access-guard';

/**
 * O caminho manual da tela de criação: abrir os próprios painéis em vez de
 * deixar o Nexus montar a equipe.
 *
 * Existe porque a capacidade foi PERDIDA, não porque faltou: o antigo
 * `product/Launcher.tsx` (hoje código morto) tinha esta mesma seção com estas
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
  const openGridDialog = () => {
    // O assistente já cuida de pasta, quantidade, uma IA por painel, limite de
    // panes, revalidação de disponibilidade e a navegação no fim.
    useTerminalGridDialogStore.getState().open({ initialCount: 2 });
  };

  const openBareShell = () => {
    // Navegar sozinho só revela a superfície (os panes ficam montados mas
    // ocultos); criar sozinho faz o pane nascer invisível. Os dois, na ordem —
    // é exatamente o que a ferramenta "Abrir terminal" do ⌘K faz.
    useProductNavigationStore.getState().openTerminal();
    try {
      useLayoutStore.getState().addShellPane();
    } catch (error) {
      // F-228: acesso negado lança LicenseError — toast padrão, sem pane.
      if (!reportLicenseDenial(error)) throw error;
      return;
    }
    // Sem esta linha o terminal novo nasce na aba dos soltos e o operador fica
    // olhando o mosaico do escopo ANTERIOR — o mesmo "abre e não aparece" que
    // F-560 corrige no assistente ao lado.
    usePaneScopeStore.getState().focusScope(LOOSE_SCOPE_KEY);
  };

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
          onClick={openGridDialog}
        />
        <ActionCard
          icon="terminal"
          size="sm"
          variant="ghost"
          title="Terminal sem IA"
          subtitle="Use comandos diretamente, sem assistente."
          onClick={openBareShell}
        />
      </div>
    </section>
  );
}
