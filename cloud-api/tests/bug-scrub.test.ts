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
/** Orçamento em tempo de CPU do processo: o relógio de parede incha quando a suíte inteira roda em paralelo. */
const BUDGET_MS = 100;
function cpuMs(work: () => void): number {
  const before = process.cpuUsage();
  work();
  const after = process.cpuUsage(before);
  return (after.user + after.system) / 1000;
}

test('a limpeza aguenta entrada patológica de 4000 caracteres sem estourar o orçamento de CPU', () => {
  for (const [name, input] of PATHOLOGICAL) {
    for (const scrub of [scrubText, scrubLine]) {
      const elapsed = cpuMs(() => { scrub(input.slice(0, LIMIT), LIMIT); });
      assert.ok(elapsed < BUDGET_MS, `${name} levou ${elapsed.toFixed(0)} ms de CPU em ${scrub.name}`);
    }
  }
});

const SESSION = 'Zk9XyWvUtSrQpOnMlKjIhGfEdCbA0123456789_-abc';
const REFRESH = 'Qp8RsTuVwXyZaBcDeFgHiJkLmNoP9876543210-_xyz';

/** Segredos achados pela revisão de segurança: cada entrada é [nome, texto, trecho que NÃO pode sobrar]. */
const MORE_LEAKS: ReadonlyArray<readonly [string, string, string]> = [
  ['JSON de login do app', JSON.stringify({ session: SESSION, refresh: REFRESH, csrf: null }), SESSION],
  ['refresh do JSON', JSON.stringify({ session: SESSION, refresh: REFRESH }), REFRESH],
  ['cabeçalho Cookie', `Cookie: __Host-nexus_session=${SESSION}; __Host-nexus_csrf=${REFRESH}`, SESSION],
  ['cookie do site com =', `__Host-nexus_session=${SESSION}`, SESSION],
  ['código OAuth no deep link', 'abri nexus://auth?code=AbCd1234EfGh5678&state=xYz98765', 'AbCd1234EfGh5678'],
  ['code_verifier', 'code_verifier=vErIfIeR1234567890abcdefghij', 'vErIfIeR1234567890'],
  ['código de licença', 'meu código NEXUS-7H3K-9QW2-XM4P não funcionou', '7H3K-9QW2-XM4P'],
  ['código de licença minúsculo e com espaços', 'nexus 7h3k 9qw2 xm4p', '7h3k'],
  ['token solto de 43 caracteres', `colei ${SESSION} sem querer`, SESSION],
  ['pass=', 'pass=hunter2xyz', 'hunter2xyz'],
  ['pw=', 'pw=hunter2xyz', 'hunter2xyz'],
  ['passphrase=', 'passphrase=hunter2xyz', 'hunter2xyz'],
  ['senha=', 'senha=hunter2xyz', 'hunter2xyz'],
  ['senha: (PT-BR, valor curto)', 'senha: hunter2xyz', 'hunter2xyz'],
  ['password: valor curto sem aspas', 'password: hunter2', 'hunter2'],
  ['auth=', 'auth=hunter2xyz', 'hunter2xyz'],
  ['jwt=', 'jwt=abc.def.ghi', 'abc.def.ghi'],
  ['signature=', 'signature=hunter2xyz', 'hunter2xyz'],
  ['--token X', 'rodei nexus --token hunter2xyz agora', 'hunter2xyz'],
  ['--password X', 'mysql --password hunter2xyz', 'hunter2xyz'],
  ['--api-key=X', 'tool --api-key=hunter2xyz', 'hunter2xyz'],
  ['curl -u', 'curl -u admin:hunter2xyz https://x.exemplo.dev', 'hunter2xyz'],
  ['?key= na URL', 'GET https://api.exemplo.dev/v1/x?key=hunter2xyz&id=1', 'hunter2xyz'],
  ['?code= na URL', 'https://x.dev/cb?code=hunter2xyz', 'hunter2xyz'],
  ['X-Amz-Signature', 'https://b.s3.amazonaws.com/o?X-Amz-Signature=hunter2xyz00', 'hunter2xyz00'],
  ['redis sem usuário', 'redis://:hunter2xyz@cache.interno:6379', 'hunter2xyz'],
  ['token como usuário da URL', 'git clone https://ghtokenvalue123@github.com/org/repo', 'ghtokenvalue123'],
  ['Authorization: Token X', 'Authorization: Token hunter2xyz', 'hunter2xyz'],
  ['chave gsk_', 'gsk_AbCdEfGhIjKlMnOpQrStUvWx', 'AbCdEfGhIjKlMnOpQrSt'],
  ['chave xai-', 'xai-AbCdEfGhIjKlMnOpQrStUvWx', 'AbCdEfGhIjKlMnOpQrSt'],
  ['token hf_', 'hf_AbCdEfGhIjKlMnOpQrStUvWx', 'AbCdEfGhIjKlMnOpQrSt'],
  ['token ya29.', 'ya29.a0AfH6SMBAbCdEfGhIjKlMnOpQrSt', 'a0AfH6SMBAbCd'],
  ['chave SendGrid', 'SG.AbCdEfGhIjKlMnOpQr.StUvWxYzAbCdEfGhIjKl', 'AbCdEfGhIjKlMnOpQr'],
  ['token xapp-', 'xapp-1-A0123456789-abcdefghij', 'A0123456789'],
  ['chave temporária da AWS', 'ASIAIOSFODNN7EXAMPLE', 'IOSFODNN7EXAMPLE'],
  ['chave Mailgun', 'key-0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
  ['SID/Key do Twilio', 'SK0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
  ['PEM de PGP', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF8abcdef\n-----END PGP PRIVATE KEY BLOCK-----', 'lQOYBF8abcdef'],
  ['PEM em minúsculas', '-----begin private key-----\nMIIEvQabcdef\n-----end private key-----', 'MIIEvQabcdef'],
  ['PEM com 4 hifens', '----BEGIN PRIVATE KEY----\nMIIEvQabcdef\n----END PRIVATE KEY----', 'MIIEvQabcdef'],
  ['sk- com ponto no meio', 'sk-proj-AbCdEf1234567890.abc123XYZ789', 'abc123XYZ789'],
  ['e-mail com acento', 'escreva para joão.conceição@gmail.com', 'conceição'],
  ['e-mail com TLD unicode', 'a@b.中国', 'a@b'],
  ['CPF formatado', 'meu CPF é 123.456.789-09', '123.456.789-09'],
  ['CNPJ formatado', 'empresa 12.345.678/0001-95', '12.345.678/0001-95'],
  ['caminho do Windows sem unidade', 'abriu \\Users\\maria\\Desktop\\x', 'maria'],
  ['bearer= em minúsculas', 'bearer=Zq9Xk2Lm7Pw4Rt8Vb3Nc', 'Zq9Xk2Lm7Pw4Rt8Vb3Nc'],
  ['Bearer: com dois pontos', 'Bearer: Zq9Xk2Lm7Pw4Rt8Vb3Nc', 'Zq9Xk2Lm7Pw4Rt8Vb3Nc'],
  ['em prosa (inglês)', 'my token is Zq9Xk2Lm7Pw4Rt8Vb3Nc ok', 'Zq9Xk2Lm7Pw4Rt8Vb3Nc'],
  ['em prosa (português)', 'a senha é Zq9Xk2Lm7Pw4Rt8Vb3Nc, anote', 'Zq9Xk2Lm7Pw4Rt8Vb3Nc'],
  ['curl --user', 'curl --user admin:Zq9Xk2Lm7Pw4Rt8Vb3Nc https://x.dev', 'Zq9Xk2Lm7Pw4Rt8Vb3Nc'],
  ['caminho UNC', '\\\\servidor\\c$\\Users\\joana\\x', 'joana'],
];

test('credenciais do próprio Nexus, flags, URLs, prefixos novos, PEM e e-mail unicode também são mascarados', () => {
  for (const [name, text, leak] of MORE_LEAKS) {
    assert.ok(!scrubText(text, LIMIT).includes(leak), `${name} vazou em scrubText`);
    assert.ok(!scrubLine(text, LIMIT).includes(leak), `${name} vazou em scrubLine`);
  }
});

test('a limpeza continua idempotente com as regras novas', () => {
  const sample = MORE_LEAKS.map(([, text]) => text).join('\n');
  const once = scrubText(sample, 20_000);
  assert.equal(scrubText(once, 20_000), once);
});

test('hash de commit, UUID, versão de pacote, código de erro e nomes comuns não são confundidos com segredo', () => {
  const plain = 'a senha é incorreta e o token é inválido; commit 3f2a124c8d9e0b1a2c3d4e5f60718293a4b5c6d7 no relato 3f2b8a52-8d0e-4f0a-9a9a-0123456789ab com react@18.2.0, node@22 e code=ENOENT; author=Maria, bypass de 12 painéis.';
  assert.equal(scrubText(plain, LIMIT), plain);
});

test('remove também seletores de variação, o selo de Braille vazio e os preenchimentos invisíveis (esconderijo de instruções)', () => {
  const hidden = 'a\uFE0Fb\u{E0100}c\u034Fd\u2800e\u3164f\uFFA0g\u180Eh\u061Ci';
  assert.equal(scrubText(hidden, LIMIT), 'abcdefghi');
});

test('a normalização NFKC não amplifica o custo: o limite vale depois dela e o tempo continua baixo', () => {
  const expands = '\u33C2'.repeat(4000); // cada um vira "a.m." (4 caracteres)
  let out = '';
  const elapsed = cpuMs(() => { out = scrubText(expands, 4000); });
  assert.ok(Array.from(out).length <= 4000);
  assert.ok(elapsed < BUDGET_MS, `levou ${elapsed.toFixed(0)} ms de CPU`);
});

test('as entradas patológicas da revisão também ficam dentro do orçamento', () => {
  for (const input of ['a.pwd.'.repeat(667), 'pwd-'.repeat(1000), 'passwd.'.repeat(570), 'secret.'.repeat(570), 'api_key.'.repeat(500), 'Cookie:'.repeat(570), '?code='.repeat(660), '--token '.repeat(500), 'NEXUS-'.repeat(660), 'a@b.'.repeat(1000), '\u2800'.repeat(4000)]) {
    for (const scrub of [scrubText, scrubLine]) {
      const elapsed = cpuMs(() => { scrub(input, LIMIT); });
      assert.ok(elapsed < BUDGET_MS, `${input.slice(0, 12)}… levou ${elapsed.toFixed(0)} ms de CPU`);
    }
  }
});
