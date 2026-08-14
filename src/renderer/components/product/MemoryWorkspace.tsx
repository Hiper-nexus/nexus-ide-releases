import { MemoryPanelBody } from './ProductPanelBodies';
import { PixelIcon } from '../PixelIcon';

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
        <div className="product-workspace__identity">
          <span className="product-workspace__badge" aria-hidden="true">
            <PixelIcon name="file" size={16} />
          </span>
          <div className="product-workspace__heading">
            <span className="product-workspace__context">Contexto local</span>
            <h1>Memória</h1>
          </div>
        </div>
        <p className="product-workspace__summary">
          Caderno deste workspace. Missões e agentes podem consultar o que
          você salvar. O Nexus guarda no app, não no repositório.
        </p>
      </header>
      <div className="product-workspace__content memory-workspace__content">
        <MemoryPanelBody showOnboarding presentation="full" />
      </div>
    </section>
  );
}
