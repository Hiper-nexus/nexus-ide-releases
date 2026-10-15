export interface HowToUseGuideHandlers {
  onOpenApiKeys: () => void;
  onOpenProviders: () => void;
  onOpenPane: () => void;
  onStartMission: () => void;
  onOpenWorkspace: () => void;
  onOpenShellTerminal: () => void;
}

/** Dense product primer: Space, + Pane, keys, and every way to start. */
export function HowToUseGuide(handlers: HowToUseGuideHandlers) {
  return (
    <section className="howto-guide" aria-labelledby="howto-guide-title">
      <h2 id="howto-guide-title" className="launcher__section-title">
        Como usar o Nexus
      </h2>
      <ul className="howto-guide__list">
        <li>
          <strong>Ditar com Space</strong>
          <p>
            Segure Space e fale; solte para transcrever no terminal selecionado.
            Toque curto é um espaço normal. ⌘⇧Space fala com a assistente.
          </p>
        </li>
        <li>
          <strong>+ Pane</strong>
          <p>
            O + da grade abre outro painel de IA ou terminal. Cada painel tem a
            sua ferramenta e a sua conversa.
          </p>
        </li>
        <li>
          <strong>Onde ficam as chaves</strong>
          <p>
            Configurações → Contas de IA para entrar na sua conta do Claude,
            Codex ou de outra ferramenta. Use Chaves de API se você tem uma chave.
          </p>
        </li>
      </ul>
      <div className="howto-guide__starts">
        <h3 className="howto-guide__starts-title">Formas de começar</h3>
        <div className="howto-guide__starts-actions">
          <button type="button" className="onboarding-btn" onClick={handlers.onStartMission}>
            Criar com IA
          </button>
          <button type="button" className="onboarding-btn" onClick={handlers.onOpenPane}>
            Montar meus terminais
          </button>
          <button type="button" className="onboarding-btn" onClick={handlers.onOpenWorkspace}>
            Abrir projeto
          </button>
          <button type="button" className="onboarding-btn" onClick={handlers.onOpenShellTerminal}>
            Terminal sem IA
          </button>
          <button type="button" className="onboarding-btn" onClick={handlers.onOpenApiKeys}>
            Chaves de API
          </button>
          <button type="button" className="onboarding-btn" onClick={handlers.onOpenProviders}>
            Contas de IA
          </button>
        </div>
      </div>
    </section>
  );
}
