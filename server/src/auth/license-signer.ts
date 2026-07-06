import { importPKCS8, importSPKI, SignJWT, jwtVerify } from 'jose';
import type { LicensePayload, PlanId } from '../../../shared/contract';

/**
 * Assina/verifica a licença JWT com Ed25519 (EdDSA). A chave privada só existe
 * no backend; a pública já está embutida no app. Infra compartilhada: o Auth
 * emite Free no exchange; o Billing reusa para Pro/Team via webhook.
 */

const ALG = 'EdDSA';
const TTL_SECONDS = 30 * 24 * 3600;

export function freeLicenseInput(email: string | null) {
  return { plan: 'free' as PlanId, email, status: 'none' as const };
}

export interface SignInput {
  plan: PlanId;
  email: string | null;
  status: LicensePayload['status'];
  renewsAt?: string | null;
  graceUntil?: string | null;
}

export async function signLicense(
  input: SignInput,
  privateKeyPem: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
  ttlSeconds: number = TTL_SECONDS,
): Promise<string> {
  const key = await importPKCS8(privateKeyPem, ALG);
  const iat = now();
  const payload: Omit<LicensePayload, 'exp'> = {
    plan: input.plan,
    email: input.email,
    status: input.status,
    renewsAt: input.renewsAt ?? null,
    graceUntil: input.graceUntil ?? null,
  };
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(key);
}

export async function verifyLicense(
  jwt: string,
  publicKeyPem: string,
): Promise<LicensePayload | null> {
  try {
    const key = await importSPKI(publicKeyPem, ALG);
    const { payload } = await jwtVerify(jwt, key, { algorithms: [ALG] });
    return {
      plan: payload.plan as PlanId,
      email: (payload.email as string) ?? null,
      status: payload.status as LicensePayload['status'],
      renewsAt: (payload.renewsAt as string) ?? null,
      graceUntil: (payload.graceUntil as string) ?? null,
      exp: payload.exp as number,
    };
  } catch {
    return null;
  }
}
