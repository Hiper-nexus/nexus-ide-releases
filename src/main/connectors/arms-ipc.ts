import { ARMS_CHANNELS } from '../../shared/channels';
import { handleTrusted } from '../security/trusted-ipc';
import {
  armsStatus,
  generateArmsToken,
  revokeArmsToken,
  rotateArmsToken,
} from './arms-token-store';
import { emitAppEvent } from './app-events';

/**
 * IPC do conector Arms (Settings › Conectores). O plaintext do token cruza a
 * ponte exatamente UMA vez, no retorno de generate/rotate — depois só existe
 * o hash em ~/.nexus/arms.json. Status nunca devolve valor.
 */

let registered = false;

export function registerArmsIpc(): void {
  if (registered) return;
  registered = true;

  handleTrusted(ARMS_CHANNELS.status, () => armsStatus());

  handleTrusted(ARMS_CHANNELS.generate, () => {
    const generated = generateArmsToken();
    emitAppEvent('arms.token', { action: 'generated' });
    return generated;
  });

  handleTrusted(ARMS_CHANNELS.rotate, () => {
    const rotated = rotateArmsToken();
    emitAppEvent('arms.token', { action: 'rotated' });
    return rotated;
  });

  handleTrusted(ARMS_CHANNELS.revoke, () => {
    revokeArmsToken();
    emitAppEvent('arms.token', { action: 'revoked' });
    return { ok: true };
  });
}
