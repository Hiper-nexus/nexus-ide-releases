import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const catalog = require('../../../resources/heavy-command/catalog.cjs') as {
  commandKind(command: string): string | null;
};

// F-982: commands from a real orchestrator session that waited up to 300 s for
// the project's build slot and then died with exit 74, although none of them
// started a build. Each one names a tool without running it.
describe('commandKind ignores tool names that are not the program being run', () => {
  it.each([
    'type git tr head node which sleep',
    'which node',
    '/opt/homebrew/opt/node@22/bin/node -v',
    'node --version',
    'for c in git node npm pnpm; do echo "$c"; done',
    `grep -n "'node'\\|npm\\|vitest" src/main/orch/heavy-command-classifier.ts | head -40`,
    'ls -la node_modules | head -2',
    'git commit -m "fix: make tsc and vitest stop queueing; npm test passes"',
    "python3 - file.ts <<'EOF'\n# one project slot must not make them queue\nmake install\nnpx vitest run\nEOF\necho done",
    'echo "run vite build later" # npm run build',
    'npm view @pierre/diffs version',
  ])('%s → null', (command) => {
    expect(catalog.commandKind(command)).toBeNull();
  });
});

describe('commandKind still meters programs that do heavy work', () => {
  it.each([
    ['npx vitest run src/a.test.ts', 'tests'],
    ['export PATH=/opt/homebrew/opt/node@22/bin:$PATH; npx vitest run a.test.ts', 'tests'],
    ['cd mobile && npx tsc --noEmit', 'typescript'],
    ['npm run typecheck', 'typescript'],
    ['npm test', 'tests'],
    ['pnpm install', 'install'],
    ['NODE_OPTIONS=--dns-result-order=ipv4first npm install @pierre/diffs@1.5.2', 'install'],
    ['npm run build', 'build'],
    ['pnpm build', 'build'],
    ['for f in a b; do npx vitest run $f; done', 'tests'],
    ['timeout 600 npx vitest run', 'tests'],
    ['node scripts/release.mjs', 'build'],
    ['cat script.js | node', 'build'],
    ['vite build', 'build'],
    ['make -j8', 'build'],
    ['cargo test', 'tests'],
    ['npm install && npx vitest run', 'tests'],
    ['/bin/sh -c "make"', 'build'],
    ["bash -lc 'cd mobile && npx vitest run'", 'tests'],
  ])('%s → %s', (command, kind) => {
    expect(catalog.commandKind(command)).toBe(kind);
  });

  it('keeps dev servers persistent and unmetered', () => {
    expect(catalog.commandKind('vite')).toBeNull();
    expect(catalog.commandKind('npx vite --port 5173')).toBeNull();
    expect(catalog.commandKind('node server.js')).toBeNull();
    expect(catalog.commandKind('"/opt/homebrew/bin/node" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 0')).toBeNull();
    expect(catalog.commandKind('node node_modules/vite/bin/vite.js build')).toBe('build');
    expect(catalog.commandKind('esbuild app.ts --watch')).toBeNull();
  });

  it('stays conservative for scripts too long to read', () => {
    expect(catalog.commandKind(`echo ${'x'.repeat(17_000)}`)).toBe('build');
  });
});

// F-982 review: reading only the command position let heavy work run with
// exit 0 and no CPU/RAM reservation. Each of these returned null.
describe('commandKind follows every way the shell reaches a heavy program', () => {
  it.each([
    // A wrapper option's value is not the program.
    ['nice -n 10 make', 'build'],
    ['env -u NAME make', 'build'],
    ['env -S "make -j8"', 'build'],
    ['timeout -s KILL 60 make', 'build'],
    ['caffeinate -t 600 make', 'build'],
    ['sudo -u x make', 'build'],
    ['/usr/bin/time -o timing.txt make', 'build'],
    ['exec -a builder make', 'build'],
    ['sudo -u x env -u HOME nice -n 5 timeout -k 5 60 make', 'build'],
    // An option the table does not know might take the program as its value.
    ['env -Z value make', 'build'],
    // xargs and find -exec run the program that follows their options.
    ['xargs make', 'build'],
    ['find . -name "*.test.ts" -print0 | xargs -0 vitest', 'tests'],
    ['ls | xargs -I{} -n 1 sh -c "make {}"', 'build'],
    ['find . -name Makefile -execdir make \\;', 'build'],
    // A shell without -c reads its program from the heredoc, here-string or pipe.
    ["sh <<'EOF'\nmake\nEOF", 'build'],
    ['bash -s <<EOF\nnpx vitest run\nEOF', 'tests'],
    ["bash <<< 'make -j8'", 'build'],
    ['echo make | sh', 'build'],
    // Only the heredoc body is skipped: the rest of its opening line runs.
    ['cat <<EOF && make\nbody\nEOF', 'build'],
    // Unquoted heredocs and double quotes still run $(…) and `…`.
    ['cat <<EOF > notes.txt\n$(make)\nEOF', 'build'],
    ['cat <<EOF\n`npx vitest run`\nEOF', 'tests'],
    ['echo "$(make)"', 'build'],
    ['echo "`make`"', 'build'],
    ['echo "${OUT:-$(npx tsc --noEmit)}"', 'typescript'],
    ['diff <(make -n) expected.txt', 'build'],
    ['x=$(case $y in a) make;; esac)', 'build'],
    // Redirections are never the program.
    ['make>/dev/null', 'build'],
    ['2>/dev/null make -j8', 'build'],
    // eval and package runners hand over a command line or a versioned bin.
    ["eval 'make -j8'", 'build'],
    ["npx -c 'vitest run'", 'tests'],
    ['npx vitest@3 run', 'tests'],
    ['npx cross-env CI=1 vitest run', 'tests'],
    // `1<<2` is arithmetic, not a heredoc that hides the next line.
    ['echo $((1<<2))\nmake', 'build'],
  ])('%s → %s', (command, kind) => {
    expect(catalog.commandKind(command)).toBe(kind);
  });

  it.each([
    ['nohup make > build.log 2>&1 &', 'build'],
    ['caffeinate -i make', 'build'],
    ['time -p make', 'build'],
  ])('keeps flag-only wrappers metered: %s → %s', (command, kind) => {
    expect(catalog.commandKind(command)).toBe(kind);
  });

  it.each([
    // The commit/PR body idiom: a quoted heredoc inside $(…) is only text.
    "git commit -m \"$(cat <<'EOF'\nfix: make vitest and tsc pass\nEOF\n)\"",
    "cat <<'EOF'\n$(make) and `npx vitest run`\nEOF\necho ok",
    "echo '$(make)'",
    'echo "\\$(make) costs \\`make\\`"',
    'command -v make',
    'sudo -l make',
    'ls | xargs -n1 basename',
    'find . -name "*.ts" | xargs grep -l make',
    'find . -name "*.log" -exec rm {} \\;',
    'sh scripts/check.sh',
    'nice -n 10 git gc',
    'timeout 5 node -v',
    'arr=(make vitest); echo "${arr[@]}"',
    'echo $((1<<2))\ngit status',
    'case "$x" in make) echo make;; esac',
    // Native wrappers: Grok evaluates a snapshot, Claude Code a quoted command.
    'snap=$(command cat <&3); builtin eval -- "$snap"; builtin eval -- "$1"',
    "source /tmp/snapshot.sh && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval 'git status' \\< /dev/null && pwd -P >| /tmp/cwd",
  ])('%s → null', (command) => {
    expect(catalog.commandKind(command)).toBeNull();
  });

  it('keeps unreadable nesting metered', () => {
    expect(catalog.commandKind(`echo ${'$('.repeat(100)}make`)).toBe('build');
  });
});

// F-982 (segunda revisão): wrappers de sistema que rodam o comando seguinte
// não estavam na tabela, então o programa era o próprio wrapper (null) e o
// trabalho pesado saía sem reserva. Cada um tem as próprias opções.
describe('commandKind lê os wrappers de sistema que faltavam', () => {
  it.each([
    ['arch -x86_64 npm install', 'install'],
    ['arch -arm64 make', 'build'],
    ['arch -arch x86_64 -e CC=clang make -j8', 'build'],
    ['arch -64 -d DYLD_LIBRARY_PATH -c npx vitest run', 'tests'],
    ['arch -Z make', 'build'],
    ['xcrun make', 'build'],
    ['xcrun --sdk macosx make -j8', 'build'],
    ['xcrun -sdk iphoneos -r make', 'build'],
    ['script -q /dev/null make', 'build'],
    ['script -c "npx vitest run" build.log', 'tests'],
    ['script build.log -c "npx tsc --noEmit"', 'typescript'],
    ['setsid -f make', 'build'],
    ['setsid --wait npm install', 'install'],
    ['flock /tmp/build.lock make', 'build'],
    ['flock -w 30 -x /tmp/build.lock npm install', 'install'],
    ['flock /tmp/build.lock -c "npx tsc --noEmit"', 'typescript'],
    ['ionice -c 3 make', 'build'],
    ['ionice -c2 -n7 npx vitest run', 'tests'],
    ['taskset 0x3 make', 'build'],
    ['taskset -c 0-3 make -j4', 'build'],
    ['chrt -b 0 make', 'build'],
    ['chrt --idle 0 npm test', 'tests'],
    ['unbuffer make', 'build'],
    ['unbuffer -p npx vitest run', 'tests'],
    ['nice -n 5 arch -arm64 xcrun make', 'build'],
  ])('%s → %s', (command, kind) => {
    expect(catalog.commandKind(command)).toBe(kind);
  });

  it.each([
    'arch',
    'arch -h',
    'xcrun -f make',
    'xcrun --find make',
    'xcrun -find make',
    'xcrun --show-sdk-path',
    'xcrun -sdk macosx --show-sdk-path',
    'script build.log',
    'flock 9',
    'flock -n 9 || exit 1',
    'ionice -p 1234',
    'ionice -c 3 -p 1234',
    'taskset -p 1234',
    'taskset -cp 0-3 1234',
    'chrt -p 1234',
    'chrt -m',
    'setsid git status',
  ])('%s → null', (command) => {
    expect(catalog.commandKind(command)).toBeNull();
  });
});

// F-982 (segunda revisão): pedir só a versão ou a ajuda não é build.
describe('commandKind deixa leves os pedidos triviais de versão e ajuda', () => {
  it.each([
    'make --version',
    'make -v',
    'tsc --version',
    'tsc -v',
    'vitest --version',
    'vitest -v',
    'npx tsc --version',
    'npx vitest --version',
    'jest --version',
    'make --help',
    'tsc -h',
  ])('%s → null', (command) => {
    expect(catalog.commandKind(command)).toBeNull();
  });

  it.each([
    // -v aqui não é versão: pytest verboso e ninja verboso rodam de verdade.
    ['pytest -v', 'tests'],
    ['ninja -v', 'build'],
    ['tsc -v -p .', 'typescript'],
    ['make -v all', 'build'],
  ])('%s → %s', (command, kind) => {
    expect(catalog.commandKind(command)).toBe(kind);
  });
});

// F-982 (segunda revisão): o argv de spawn/execFile não passa por shell.
describe('argvKind classifica o argv direto, palavra por palavra', () => {
  const argvKind = (catalog as unknown as { argvKind(argv: string[]): string | null }).argvKind;
  it.each([
    [['rg', '-e', 'a|vitest'], null],
    [['git', 'commit', '-m', 'fix: queue\nmake all'], null],
    [['grep', '-r', '$(make)', '.'], null],
    [['echo', 'a;', 'npx', 'vitest'], null],
    [['make', '--version'], null],
    [['make', '-j8'], 'build'],
    [['/usr/bin/env', 'make'], 'build'],
    [['/bin/sh', '-c', 'npx vitest run'], 'tests'],
    [['arch', '-arm64', 'npm', 'install'], 'install'],
    [['npx', 'tsc', '--noEmit'], 'typescript'],
  ] as Array<[string[], string | null]>)('%j → %s', (argv, kind) => {
    expect(argvKind(argv)).toBe(kind);
  });
});
