// Gera um código de licença ("tenho um código" no app) e o INSERT para o D1.
// O banco guarda só sha256(código normalizado) — nunca o plaintext.
//
//   node scripts/mint-license-code.mjs [--days N] [--uses N] [--expires-days N] [--note "texto"] > /tmp/code.sql
//   npx wrangler d1 execute nexus-cloud-staging --remote --file /tmp/code.sql
//
// --days N         : licença concedida dura N dias (omitido = perpétua)
// --uses N         : quantas contas podem resgatar (default 1)
// --expires-days N : prazo para RESGATAR o código (omitido = sem prazo)
// --note "..."     : rótulo interno visível no painel admin
// O código em claro sai no stderr — anote-o; não dá para recuperar depois.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const args = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index];
  if (!key?.startsWith('--') || argv[index + 1] === undefined) {
    process.stderr.write(`Uso: node scripts/mint-license-code.mjs [--days N] [--uses N] [--expires-days N] [--note "texto"]\n`);
    process.exit(2);
  }
  args[key.slice(2)] = argv[index + 1];
}
// Mesmos tetos da rota de admin e dos CHECKs da migration 0005.
const LIMITS = { days: 36500, uses: 100, 'expires-days': 3650 };
const int = (name) => {
  const value = args[name];
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > LIMITS[name]) { process.stderr.write(`--${name} precisa ser inteiro entre 1 e ${LIMITS[name]}\n`); process.exit(2); }
  return parsed;
};

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford, sem 0/O/1/I/L
const bytes = randomBytes(12);
const body = [...bytes].map((byte) => ALPHABET[byte % 32]);
const code = `NEXUS-${body.slice(0, 4).join('')}-${body.slice(4, 8).join('')}-${body.slice(8, 12).join('')}`;
// Mesmo normalizeLicenseCode do src/license-codes.ts: maiúsculas, só alfanumérico.
const hash = createHash('sha256').update(code.toUpperCase().replace(/[^0-9A-Z]/g, '')).digest('hex');

const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const periodDays = int('days');
const maxUses = int('uses') ?? 1;
const expiresIn = int('expires-days');
const note = (args.note ?? '').slice(0, 200);
const quote = (value) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;

const row = {
  id: randomUUID(), code_hash: hash, code_suffix: code.slice(-4), plan: 'pro',
  period_days: periodDays, max_uses: maxUses, note,
  created_by: null, expires_at: expiresIn === null ? null : now + expiresIn * DAY,
  revoked_at: null, created_at: now,
};
process.stdout.write(`INSERT INTO license_codes(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(quote).join(',')});\n`);
process.stderr.write(`Código: ${code}\nDuração: ${periodDays === null ? 'perpétua' : `${periodDays} dias`} · Usos: ${maxUses}\nGuarde o código — ele não pode ser recuperado do banco.\n`);
