import path from 'node:path';
import { RUNTIME_GATES_ENV, RUNTIME_GATEWAY_ENV, RUNTIME_GATEWAY_NONCE_ENV, RUNTIME_PHASE_ENV } from '../shared/runtime-gates';
import { soakNonce } from '../shared/soak-smoke';
export function runtimeGateConfiguration(input: { smokeTest: boolean; packaged: boolean; userData: string; env: NodeJS.ProcessEnv }):
  { gateway: string; gatewayNonce: string; phase: 'exercise' | 'resume' } | null {
  const env = input.env, phase = env[RUNTIME_PHASE_ENV];
  if (!input.smokeTest || !input.packaged || env[RUNTIME_GATES_ENV] !== '1' || env.NEXUS_PACKAGED_SMOKE !== '1' ||
    !path.isAbsolute(input.userData) || env.NEXUS_USER_DATA_DIR !== input.userData || env.HOME !== path.join(input.userData, 'home') ||
    !soakNonce.safeParse(env[RUNTIME_GATEWAY_NONCE_ENV]).success || !['exercise', 'resume'].includes(phase ?? '')) return null;
  try {
    const url = new URL(env[RUNTIME_GATEWAY_ENV] ?? '');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { gateway: url.origin, gatewayNonce: env[RUNTIME_GATEWAY_NONCE_ENV]!, phase: phase as 'exercise' | 'resume' };
  } catch { return null; }
}
