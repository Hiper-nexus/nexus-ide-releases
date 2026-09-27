import fs from 'node:fs';
import path from 'node:path';

/**
 * Ao abrir um projeto que JÁ adotou o `.context` (tem `.context/docs`), mantém
 * o modelo de negócio em dia em segundo plano. Projeto sem `.context` não é
 * tocado: o scaffold continua sendo do autopilot/doctor. O bootstrap é
 * carregado sob demanda para não arrastar o grafo do `.context` para a
 * abertura de workspace.
 */
export function scheduleBusinessModelRefreshForWorkspace(workspacePath: string): void {
  if (!fs.existsSync(path.join(workspacePath, '.context', 'docs'))) return;
  const timer = setTimeout(() => {
    try {
      const { refreshBusinessModelForWorkspace } =
        require('./business-model-bootstrap') as typeof import('./business-model-bootstrap');
      refreshBusinessModelForWorkspace(workspacePath);
    } catch (error) {
      console.warn('[business-model] refresh unavailable:', error instanceof Error ? error.message : String(error));
    }
  }, 0);
  timer.unref?.();
}
