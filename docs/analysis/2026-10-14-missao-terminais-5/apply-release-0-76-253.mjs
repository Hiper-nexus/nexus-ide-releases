// Aplica a versão 0.76.253 na árvore indicada (argv[2]). Uso: node apply-release-0-76-253.mjs <repo> [--with-relay]
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2];
const withRelay = process.argv.includes('--with-relay');
const FROM = '0.76.252';
const TO = '0.76.253';
const DATE = '2026-10-14';
const CODENAME = 'Troca de conta sem perder nada';
const p = (f) => path.join(repo, f);
const read = (f) => fs.readFileSync(p(f), 'utf8');
const write = (f, s) => fs.writeFileSync(p(f), s);

function bump(file, expected) {
  const s = read(file);
  const re = new RegExp(`("version": ")${FROM.replaceAll('.', '\\.')}(")`, 'g');
  const n = (s.match(re) ?? []).length;
  if (n !== expected) throw new Error(`${file}: esperava ${expected} ocorrência(s) de ${FROM}, achei ${n}`);
  write(file, s.replace(re, `$1${TO}$2`));
}
bump('package.json', 1);
bump('server/package.json', 1);
bump('package-lock.json', 3);

const q = (s) => s.replaceAll("'", "\\'");
const highlights = [
  ['A missão não para quando a conta acaba', 'Quando uma conta atinge o limite de uso, o pane troca para outra conta do mesmo provedor e segue a tarefa, na mesma pasta. A troca encadeia entre várias contas, espera até 24 horas se todas esgotarem e retoma sozinha depois de reiniciar o app.'],
  ['A mesma conversa na conta nova', 'No Claude, a troca de conta continua a mesma conversa (só depois de provar que retomou; senão, sessão nova com resumo), e o último pedido em andamento vai junto, o mais recente sempre inteiro.'],
  ['Coordenador sempre volta', 'O Maestro não é mais recusado com «orchestrator physical spawn authority is missing or mismatched» quando a conta escolhida muda: ele volta na conta com folga do mesmo provedor e, se houver recusa, ela diz o motivo em português.'],
];
const fixes = [
  ['Limite avisado pelo Claude troca na hora', 'Quando o próprio Claude avisa que a conta bateu o limite, a troca acontece uma vez só, sem a pausa de 15 minutos, e o bloqueio da conta vai até a cota voltar de verdade.'],
  ['Um Maestro só na tela', 'A missão não acumula mais panes mortos do coordenador depois de religar ou atualizar o app.'],
  ['AGY ao vivo', 'O pane do Antigravity mostra o trabalho enquanto acontece, em vez de ficar preto até terminar.'],
  ['Mais modelos nas revisões', 'Revisões somente leitura usam todos os modelos de ponta prontos; o portão de integração continua com Claude/Codex. CLI parada na tela de login sai da rota até você logar.'],
  ['Grok sem login a cada pane', 'No Windows o Grok não pede login a cada pane: a renovação volta para o perfil, e sem login válido aparece «Entrar no Grok» em vez de panes mudos.'],
  ['Celular pelo QR', `O QR de controle volta a dar controle, o celular diz por que não conectou, os links copiam o endereço https certo e o QR velho dá lugar a «Gerar novo QR».${withRelay ? ' O servidor de conexão do celular foi para a Cloudflare.' : ''}`],
  ['Celular na rede local', 'A porta não muda a cada início, há o botão «Parar», «Iniciar neste computador» volta a ser só local e a tela diz o que fazer quando ninguém conecta.'],
  ['Sem erro vermelho no Windows', 'O hook do Nexus no Claude não estoura mais o tempo no Windows nem despeja o comando em base64 na tela.'],
  ['Comandos pesados no horário de verão', 'No macOS e no Linux, a vaga de comando pesado não é liberada com processo ainda rodando na volta do horário de verão.'],
  ['Squads mais firmes', 'Editor e importação de squads recusam nome repetido com o nome, aceitam arquivo UTF-16 e com BOM do Windows, leem frontmatter CRLF, recusam CON/NUL e aceitam pastas em 8.3 e com outra caixa.'],
];
const item = ([t, d]) => `    { title: '${q(t)}', detail: '${q(d)}' },`;
const block = `export const CURRENT_RELEASE: AppRelease = {
  version: '${TO}',
  date: '${DATE}',
  codename: '${q(CODENAME)}',
  summary: '${q('Quando uma conta atinge o limite, o Maestro e os workers trocam para outra conta do mesmo provedor sem parar a missão e sem perder a conversa, o pedido em andamento, a pasta nem a tarefa. O coordenador volta sempre, o Grok não pede login a cada pane no Windows, o AGY aparece ao vivo e o celular volta a conectar.')}',
  highlights: [
${highlights.map(item).join('\n')}
  ],
  fixes: [
${fixes.map(item).join('\n')}
  ],
};
`;
let notes = read('src/shared/release-notes.ts');
const anchor = 'export const CURRENT_RELEASE: AppRelease = {';
const at = notes.lastIndexOf(anchor);
if (at < 0 || !notes.slice(at).includes(`version: '${FROM}'`)) throw new Error('CURRENT_RELEASE 0.76.252 não encontrado');
notes = notes.slice(0, at) + notes.slice(at).replace(anchor, 'export const RELEASE_076252: AppRelease = {');
notes = notes.trimEnd() + '\n' + block;
write('src/shared/release-notes.ts', notes);

const changelog = read('CHANGELOG.md');
const section = `## ${TO} — ${CODENAME}

A troca de conta por cota não para mais a missão. Quando uma conta atinge o limite, o pane troca para a próxima conta do mesmo provedor e segue, no Claude na mesma conversa, levando o último pedido em andamento (F-1470, F-1471, F-1473, F-1480, F-1482, F-1483, F-1484, F-1486, F-1488).

- **Coordenador.** O Maestro volta na conta com folga em vez de ser recusado com «orchestrator physical spawn authority is missing or mismatched», a recusa diz o motivo em português (F-1470) e a missão mostra um Maestro só, sem panes mortos acumulados (F-1475).
- **CLIs.** O pane do AGY mostra o trabalho ao vivo (F-1476); revisões somente leitura usam todos os modelos de ponta e CLI presa no login sai da rota (F-1477); o Grok no Windows não pede login a cada pane (F-1485).
- **Celular.** O QR de controle volta a dar controle e o celular diz por que não conectou (F-1472${withRelay ? ', F-1487' : ''}); na rede local a porta é fixa, há «Parar» e a tela orienta o que fazer (F-1478).
- **Windows.** O hook do Nexus não estoura mais o tempo do Claude nem mostra base64 em vermelho (F-1474).
- **macOS/Linux.** A vaga de comando pesado não é liberada com processo vivo na volta do horário de verão (F-1479).
- **Squads.** Editor, importação e preparo de squads mais firmes no Windows e com rosters antigos (F-1490..F-1511).

`;
const head = /^# Changelog\r?\n\r?\n/.exec(changelog);
if (!head) throw new Error('CHANGELOG sem cabeçalho esperado');
const eol = changelog.includes('\r\n') ? '\r\n' : '\n';
write('CHANGELOG.md', head[0] + section.replaceAll('\n', eol) + changelog.slice(head[0].length));
console.log(`ok: ${TO} aplicada${withRelay ? ' (com relay)' : ''}`);
