import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const script = readFileSync(new URL('../../public/install-repo.sh', import.meta.url), 'utf8');
const scriptPath = new URL('../../public/install-repo.sh', import.meta.url).pathname;
const key = readFileSync(new URL('../../public/linux/nexus-ide.asc', import.meta.url), 'utf8');
const repoFile = readFileSync(new URL('../../public/linux/nexus-ide.repo', import.meta.url), 'utf8');

test('é um script sh válido e para na primeira falha', () => {
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /^set -eu$/m);
  assert.equal(spawnSync('sh', ['-n', scriptPath], { encoding: 'utf8' }).status, 0);
});

test('só fala com nexuside.app, não executa texto baixado e só apaga o que é seu', () => {
  assert.ok(script.includes('SITE="https://nexuside.app"'));
  assert.doesNotMatch(script, /\beval\b/);
  for (const forbidden of ['apt-key', 'add-apt-repository', 'rpm --import', 'gpg --import', 'trusted=yes', 'allow-insecure', '--nogpgcheck']) {
    assert.ok(!script.includes(forbidden), `não deveria usar ${forbidden}`);
  }
  const removals = [...script.matchAll(/rm (-rf|-f) ("[^"]+"|\S+( "[^"]+")*)/g)].map(match => match[0]);
  for (const removal of removals) assert.match(removal, /\$TMP|\$APT_LIST|\$APT_KEYRING|\$DNF_REPO/, `remoção inesperada: ${removal}`);
});

test('a impressão digital fixada é a da chave pública publicada em /linux/nexus-ide.asc', () => {
  const pinned = /^KEY_FPR="([0-9A-F]{40})"$/m.exec(script)?.[1];
  assert.ok(pinned, 'KEY_FPR ausente');
  const gpg = spawnSync('gpg', ['--show-keys', '--with-colons'], { input: key, encoding: 'utf8' });
  if (gpg.error) return; // sem gpg no ambiente de teste
  const fingerprint = gpg.stdout.split('\n').find(line => line.startsWith('fpr:'))?.split(':')[9];
  assert.equal(fingerprint, pinned);
});

test('o dnf exige a assinatura dos índices e a chave vem do mesmo endereço do apt', () => {
  assert.match(script, /^repo_gpgcheck=1$/m);
  assert.match(script, /^gpgcheck=0$/m); // o RPM em si não é assinado; o índice assinado lista o SHA-256
  assert.match(script, /^gpgkey=\$SITE\/linux\/nexus-ide\.asc$/m);
  assert.match(script, /deb \[signed-by=%s\] %s\/apt\/ \.\/\\n/);
  // O .repo publicado no site é o mesmo que o script grava.
  assert.match(repoFile, /^baseurl=https:\/\/nexuside\.app\/rpm\/$/m);
  assert.match(repoFile, /^repo_gpgcheck=1$/m);
  assert.match(repoFile, /^gpgkey=https:\/\/nexuside\.app\/linux\/nexus-ide\.asc$/m);
});

test('recusa Arch, Omarchy e openSUSE e manda para o instalador comum', () => {
  assert.match(script, /No Arch, Omarchy e openSUSE use: curl -fsSL \$SITE\/install\.sh \| sh/);
});

test('tem --remove e --help e recusa opção desconhecida', () => {
  assert.match(script, /--remove\) REMOVE=1/);
  const help = spawnSync('sh', [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /NexusIDE para Linux/);
  const bad = spawnSync('sh', [scriptPath, '--nao-existe'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /opção desconhecida/);
});
