import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubDiagnostics, scrubLine, scrubText } from '../src/bugs/scrub.js';

const LIMIT = 4000;

/** Cada item é um segredo que, se sobrar na saída, é um vazamento. */
const SECRETS: ReadonlyArray<readonly [string, string]> = [
  ['chave sk- da OpenAI', 'sk-proj-AbCdEf1234567890abcdef1234567890'],
  ['chave sk-ant da Anthropic', 'sk-ant-api03-Zk9XyWvUtSrQpOnMlKjIhGfEdCbA'],
  ['chave do Resend', 're_AbCdEfGh_1234567890abcdefghijklmnop'],
  ['token do GitHub', 'ghp_1234567890abcdefghijklmnopqrstuvwxyz'],
  ['token fino do GitHub', 'github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz0123456789'],
  ['chave secreta do Stripe', 'sk_live_51HabcdefGHIJKLmnopqrstuv'],
  ['segredo de webhook do Stripe', 'whsec_AbCdEfGhIjKlMnOpQrStUvWx'],
  ['chave da AWS', 'AKIAIOSFODNN7EXAMPLE'],
  ['token do Slack', 'xoxb-1234567890-abcdefghijklmnop'],
  ['JWT de três partes', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ['credencial na URL', 'postgres://admin:S3nh4Superse9ret@db.interno:5432/prod'],
  ['bloco de chave privada', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabcdef\n-----END PRIVATE KEY-----'],
];

test('mascara cada tipo de segredo nos campos livres, em linha e em texto', () => {
  for (const [name, secret] of SECRETS) {
    const body = `Quebrou quando usei ${secret} no terminal`;
    const piece = secret.split('\n').find(part => part.length > 12) ?? secret;
    assert.ok(!scrubText(body, LIMIT).includes(piece), `${name} vazou em scrubText`);
    assert.ok(!scrubLine(body, LIMIT).includes(piece), `${name} vazou em scrubLine`);
  }
});

test('mascara Bearer, Basic e cabeçalhos de autorização', () => {
  const out = scrubText('curl -H "Authorization: Bearer abc123DEF456ghi789" e Authorization: Basic dXNlcjpwYXNzd29yZA==', LIMIT);
  assert.doesNotMatch(out, /abc123DEF456ghi789/);
  assert.doesNotMatch(out, /dXNlcjpwYXNzd29yZA/);
});

test('mascara linhas KEY=valor de ambiente (inclusive export, aspas e PowerShell) e chaves sensíveis em minúsculas', () => {
  const out = scrubText([
    'OPENAI_API_KEY=abc-valor-secreto-1',
    'export STRIPE_SECRET_KEY="valor com espaco 2"',
    "$env:DATABASE_URL='valor-3'",
    'set NOTICE_SECRET=valor-4',
    'api_key=valor-5',
    'password = hunter2-valor-6',
    '{"token":"valor-7"}',
  ].join('\n'), LIMIT);
  for (const n of ['valor-secreto-1', 'espaco 2', 'valor-3', 'valor-4', 'valor-5', 'hunter2-valor-6', 'valor-7']) assert.ok(!out.includes(n), `vazou ${n}`);
  assert.match(out, /OPENAI_API_KEY=\[oculto\]/, 'a chave fica, só o valor some');
});

test('mascara caminhos de HOME de macOS, Linux e Windows, mantendo o resto do caminho', () => {
  const out = scrubText('Falhou em /Users/cleofasrocha/dev/app/main.ts, /home/maria/x e C:\\Users\\Maria Silva\\AppData\\Local\\nexus e c:/users/joao/tmp', LIMIT);
  for (const n of ['cleofasrocha', 'maria', 'Maria', 'Silva', 'joao']) assert.ok(!out.includes(n), `vazou ${n}`);
  assert.match(out, /\/Users\/\[usuario\]\/dev\/app\/main\.ts/);
  assert.match(out, /C:\\Users\\\[usuario\]\\AppData\\Local\\nexus/);
});

test('mascara e-mails no meio do texto', () => {
  const out = scrubText('Fale comigo em fulano.da-silva+nexus@exemplo.com.br ou git@github.com:org/repo', LIMIT);
  assert.doesNotMatch(out, /fulano|exemplo\.com|git@github/);
  assert.match(out, /\[email\]/);
});

test('remove caracteres de controle, ANSI, bidi, largura zero e caracteres Tag invisíveis', () => {
  const dirty = 'a\u0000b\u0007c\u001b[31mvermelho\u001b[0m\u202Eexe.txt\u200Bz\uFEFF\u{E0041}\u{E0042}fim\u0085x\u2028y';
  const out = scrubText(dirty, LIMIT);
  assert.equal(out, 'abcvermelhoexe.txtzfim\nx\ny');
  assert.doesNotMatch(out, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u);
});

test('não deixa o atacante partir um segredo com caracteres invisíveis ou largura total para escapar da máscara', () => {
  const split = 'sk-\u200Bproj-AbCdEf1234567890abcdef12\u200D34567890';
  assert.doesNotMatch(scrubText(split, LIMIT), /AbCdEf1234567890/);
  const fullWidth = 'ｓｋ-proj-AbCdEf1234567890abcdef1234567890';
  assert.doesNotMatch(scrubText(fullWidth, LIMIT), /AbCdEf1234567890/);
});

test('scrubLine devolve uma linha só: quebras viram espaço e os espaços repetidos colapsam', () => {
  assert.equal(scrubLine('  titulo\r\ncom   quebra\ne\ttab  ', 120), 'titulo com quebra e tab');
});

test('scrubText limita a duas quebras seguidas, apara o fim das linhas e preserva a indentação', () => {
  assert.equal(scrubText('a  \n\n\n\n\nb\n\tindentado   \n', LIMIT), 'a\n\nb\n  indentado');
});

test('o limite de tamanho vale DEPOIS da máscara e não corta um par substituto ao meio', () => {
  assert.equal(scrubLine('x'.repeat(500), 120).length, 120);
  const emoji = scrubLine('😀'.repeat(200), 120);
  assert.equal(Array.from(emoji).length, 120);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF]$/);
});

test('mascarar duas vezes dá o mesmo resultado (idempotente)', () => {
  const sample = SECRETS.map(([, secret]) => secret).join('\n') + '\nOPENAI_API_KEY=abc\n/Users/fulano/x\nfulano@x.com\nAuthorization: Bearer abc123DEF456ghi789';
  const once = scrubText(sample, 10_000);
  assert.equal(scrubText(once, 10_000), once);
});

test('não estraga texto comum de relato de bug', () => {
  const plain = 'O terminal fecha ao abrir 3 painéis no Windows 11. Versão 0.76.110, tokens: 1200, author=Maria, task-force e risk-assessment ok.';
  assert.equal(scrubText(plain, LIMIT), plain);
});

test('scrubDiagnostics mascara segredos, caminhos e e-mails em eventos e erros e respeita os tamanhos', () => {
  const out = scrubDiagnostics({
    events: [{ t: 1700, kind: 'pty.exit', code: 'ENOENT /Users/fulano/x' }, { t: 1800, kind: 'k'.repeat(100) }],
    errors: ['falhou com sk-proj-AbCdEf1234567890abcdef1234567890 em fulano@x.com', 'e'.repeat(500)],
  });
  const dump = JSON.stringify(out);
  assert.doesNotMatch(dump, /fulano|AbCdEf1234567890/);
  assert.equal(out.events[1]!.kind.length, 40);
  assert.equal(out.errors[1]!.length, 200);
  assert.equal(out.events[0]!.t, 1700);
});

/** Entradas montadas para fazer regex com quantificadores gananciosos sobrepostos explodir. Cada uma cabe nos 4000 caracteres do contrato. */
const PATHOLOGICAL: ReadonlyArray<readonly [string, string]> = [
  ['pwd. repetido', 'pwd.'.repeat(1000)],
  ['token. repetido', 'token.'.repeat(666)],
  ['secret- repetido', 'secret-'.repeat(570)],
  ['api_key sem valor', 'api_key'.repeat(570)],
  ['só letras', 'a'.repeat(4000)],
  ['a. repetido', 'a.'.repeat(2000)],
  ['A_ repetido e =', `${'A_'.repeat(1999)}=`],
  ['Bearer repetido', 'Bearer '.repeat(570)],
  ['PEM repetido sem fim', '-----BEGIN PRIVATE KEY-----'.repeat(140)],
  ['eyJ repetido', 'eyJ'.repeat(1333)],
  ['esquema:// repetido', 'x://'.repeat(1000)],
  ['arroba repetida', 'a@'.repeat(2000)],
  ['e-mail sem fim', `${'a'.repeat(3990)}@b`],
  ['aspas abertas', 'token="'.repeat(570)],
  ['espaços após a chave', `token${' '.repeat(3990)}`],
  ['barras de usuário', 'C:\\Users\\'.repeat(400)],
  ['chave:valor encadeado', 'token=a.b.c:'.repeat(330)],
  ['api_key: repetido', 'api_key: '.repeat(440)],
  ['Authorization: Bearer repetido', 'Authorization: Bearer '.repeat(180)],
  ['segmentos a.b.', 'a.b.'.repeat(1000)],
  ['secret_ repetido', `${'secret_'.repeat(570)}x`],
];
const BUDGET_MS = 100;

test('a limpeza aguenta entrada patológica de 4000 caracteres sem estourar o orçamento de CPU', () => {
  for (const [name, input] of PATHOLOGICAL) {
    for (const scrub of [scrubText, scrubLine]) {
      const started = performance.now();
      scrub(input.slice(0, LIMIT), LIMIT);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < BUDGET_MS, `${name} levou ${elapsed.toFixed(0)} ms em ${scrub.name}`);
    }
  }
});
