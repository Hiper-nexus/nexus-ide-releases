import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { RELEASE_REPOSITORY } from './releases.js';

const script = readFileSync(new URL('../../public/install.sh', import.meta.url), 'utf8');
const scriptPath = new URL('../../public/install.sh', import.meta.url).pathname;

test('o instalador é um script sh válido e para na primeira falha', () => {
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /^set -eu$/m);
  const check = spawnSync('sh', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('só baixa do espelho público de releases que o site usa, e nomeia os pacotes como o catálogo', () => {
  const prefix = `${RELEASE_REPOSITORY}/releases/download/v`;
  assert.ok(script.includes(`RELEASES_PREFIX="${prefix}"`), 'o prefixo do espelho tem que ser o mesmo de releases.js');
  assert.ok(script.includes('SITE="https://nexuside.app"'));
  // Os três nomes que o canal Linux publica (nexus-ide/scripts/publish-linux-release.mjs) e o catálogo exige.
  assert.ok(script.includes('nexus-ide_"$VERSION"_amd64.deb'));
  assert.ok(script.includes('nexus-ide-"$VERSION"-1.x86_64.rpm'));
  assert.ok(script.includes('NexusIDE-linux-x64-"$VERSION".zip'));
  assert.ok(script.includes('SUMS_NAME="SHA256SUMS-linux-x64.txt"'));
  for (const format of ['deb', 'rpm', 'zip']) assert.match(script, new RegExp(`FORMAT="${format}"`));
});

test('confere o SHA-256 ANTES de instalar qualquer coisa', () => {
  const verified = script.indexOf('SHA-256 conferido');
  assert.ok(verified > 0);
  for (const install of ['as_root apt-get install', 'as_root dnf install', 'as_root yum install', 'as_root zypper --non-interactive install', 'mv "$STAGE/', 'ln -sf']) {
    const at = script.indexOf(install);
    assert.ok(at > verified, `${install} aparece antes da conferência do hash`);
  }
  assert.match(script, /die "o SHA-256 do download NÃO confere/);
});

test('não executa texto baixado nem mexe no sistema além do pacote', () => {
  assert.doesNotMatch(script, /\beval\b/);
  // Nada de repositório, chave ou configuração do sistema.
  for (const forbidden of ['/etc/apt', '/etc/yum.repos.d', 'apt-key', 'add-apt-repository', 'rpm --import', 'gpg --import']) {
    assert.ok(!script.includes(forbidden), `não deveria tocar em ${forbidden}`);
  }
  // O único rm -rf é do diretório temporário e dos próprios arquivos de instalação.
  const removals = [...script.matchAll(/rm -rf ("[^"]+"|\S+)/g)].map(match => match[1]);
  for (const target of removals) assert.match(target, /\$TMP|\$DEST\.(new|old)|"\$TMP"|\$STAGE/, `rm -rf inesperado: ${target}`);
});

test('o portátil avisa quando falta o bubblewrap, que só os pacotes puxam como dependência', () => {
  const zipBranch = script.slice(script.indexOf('  zip)\n'));
  assert.match(zipBranch, /have bwrap \|\| warn /);
  // É só um aviso: o instalador não chama gerenciador de pacotes no modo portátil.
  assert.doesNotMatch(zipBranch.slice(0, zipBranch.indexOf('esac\n\nsay ""')), /as_root /);
});

test('o portátil extrai no mesmo disco do destino e não no /tmp, e recusa instalar pela metade', () => {
  const zipBranch = script.slice(script.indexOf('  zip)\n'));
  assert.match(zipBranch, /STAGE="\$\(dirname "\$DEST"\)\/\.nexus-ide-install\.\$\$"/);
  assert.doesNotMatch(zipBranch, /unzip -q "\$TMP\/\$FILE" -d "\$TMP\/x"/);
  assert.match(zipBranch, /nada foi instalado/);
  // A pasta velha só sai DEPOIS de a nova estar inteira e conferida.
  assert.ok(zipBranch.indexOf('o pacote portátil veio sem o executável') < zipBranch.indexOf('mv "$DEST" "$DEST.old"'));
});
