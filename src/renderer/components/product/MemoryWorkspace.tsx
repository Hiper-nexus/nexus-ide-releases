import { MemoryPanelBody } from './ProductPanelBodies';

export interface MemoryWorkspaceProps {
  className?: string;
}

export function MemoryWorkspace({ className = '' }: MemoryWorkspaceProps = {}) {
  return (
    <section
      className={`product-workspace memory-workspace ${className}`.trim()}
      aria-label="Memória do workspace"
    >
      <header className="product-workspace__header">
        <div className="product-workspace__heading">
          <span className="product-workspace__context">Contexto local</span>
          <h1>Memória</h1>
        </div>
        <p className="product-workspace__summary">
          Decisões e aprendizados disponíveis neste workspace.
        </p>
      </header>
      <div className="product-workspace__content memory-workspace__content">
        <MemoryPanelBody showOnboarding presentation="full" />
      </div>
    </section>
  );
}
