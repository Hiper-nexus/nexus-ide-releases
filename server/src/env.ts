import { z } from 'zod';

/**
 * Env validado no boot — falta de qualquer segredo derruba o processo cedo,
 * com mensagem clara, em vez de falhar no primeiro request.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  LICENSE_PRIVATE_KEY: z.string().includes('PRIVATE KEY'),
  LICENSE_PUBLIC_KEY: z.string().includes('PUBLIC KEY'),
  GITHUB_OAUTH_ID: z.string().min(1),
  GITHUB_OAUTH_SECRET: z.string().min(1),
  GOOGLE_OAUTH_ID: z.string().min(1),
  GOOGLE_OAUTH_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),
  APP_DEEP_LINK_BASE: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => i.path.join('.'))
      .join(', ');
    throw new Error(`env inválido/faltando: ${missing}`);
  }
  return result.data;
}
