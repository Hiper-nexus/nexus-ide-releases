import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_AUTH_SYNCBACK_MARKER } from '../orch/hooks-gen';
import { syncBackStaleClaudeOverlayAuth } from '../orch/overlay-auth-syncback';

/**
 * Antes de a higiene de disco apagar um HOME efêmero órfão (pane morto sem
 * teardown): o overlay que carregou a identidade nativa do Claude (marcador)
 * pode guardar um /login feito no pane que só existe ali. Ele volta ao perfil
 * real se for mais novo — o mesmo resgate do teardown, com a guarda de idade.
 * `false` (falha inesperada) mantém o overlay para a próxima rodada.
 */
export function rescueOrphanSessionOverlay(overlayDir: string, realHome: string = os.homedir()): boolean {
  try {
    if (fs.existsSync(path.join(overlayDir, CLAUDE_AUTH_SYNCBACK_MARKER))) {
      syncBackStaleClaudeOverlayAuth(overlayDir, realHome);
    }
    return true;
  } catch {
    return false;
  }
}
