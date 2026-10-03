import { describe, expect, it } from 'vitest';
import {
  isShellHttpCommand,
  normalizeSkillName,
  observerToolKind,
} from './observer-tool-kind';

describe('F-780: categoria da tool pelo nome', () => {
  it.each([
    // Navegador do Nexus em todas as formas de nome de servidor MCP vistas
    // no journal da missão Terminais (Claude, Codex e servidor por sessão).
    ['mcp__nexus__nexus_browser_read', 'nexus-browser'],
    ['nexus_2899e252c359__nexus_browser_open', 'nexus-browser'],
    ['mcp__nexus_fec651c581f7__nexus_browser_navigate', 'nexus-browser'],
    ['nexus_browser_read', 'nexus-browser'],
    // Demais tools do Nexus.
    ['mcp__nexus__nexus_pane_spawn', 'nexus'],
    ['nexus_2899e252c359__nexus_handoff_submit', 'nexus'],
    ['mcp__nexus_fec651c581f7__nexus_worker_heartbeat', 'nexus'],
    ['nexus_memory_recall', 'nexus'],
    // MCP de terceiros (Playwright, Firecrawl, hub do workspace).
    ['mcp__playwright__browser_navigate', 'mcp'],
    ['mcp__firecrawl__firecrawl_scrape', 'mcp'],
    ['context7__resolve-library-id', 'mcp'],
    // Página e busca fora do navegador do Nexus.
    ['WebFetch', 'fetch'],
    ['web_fetch', 'fetch'],
    ['FetchURL', 'fetch'],
    ['read_url_content', 'fetch'],
    ['WebSearch', 'web-search'],
    ['google_web_search', 'web-search'],
    ['SearchWeb', 'web-search'],
    ['Skill', 'skill'],
    // Nativas que a missão Terminais gravou.
    ['Bash', 'execute'],
    ['run_terminal_command', 'execute'],
    ['Read', 'read'],
    ['read_file', 'read'],
    ['grep', 'search'],
    ['Grep', 'search'],
    ['Edit', 'edit'],
    ['search_replace', 'edit'],
    ['apply_patch', 'edit'],
    ['write', 'edit'],
    ['collaborationspawn_agent', 'agent'],
    ['collaborationsend_message', 'agent'],
    ['Task', 'agent'],
    ['TodoList', 'think'],
    ['update_plan', 'think'],
    ['ToolSearch', 'other'],
  ])('%s → %s', (name, kind) => {
    expect(observerToolKind(name)).toBe(kind);
  });

  it('nome específico vence a categoria declarada; nome genérico cede a ela', () => {
    // ACP: o título é texto livre e o `kind` do protocolo é o que informa.
    expect(observerToolKind('Lendo a configuração', 'read')).toBe('read');
    expect(observerToolKind('mcp__nexus__nexus_browser_read', 'other')).toBe('nexus-browser');
    expect(observerToolKind('WebFetch', 'read')).toBe('fetch');
  });

  it('shell-http refina só o shell: Bash com curl vira shell-http, Read não', () => {
    expect(observerToolKind('Bash', 'shell-http')).toBe('shell-http');
    expect(observerToolKind('run_terminal_command', 'shell-http')).toBe('shell-http');
    expect(observerToolKind('Read', 'shell-http')).toBe('read');
    expect(observerToolKind('Bash')).toBe('execute');
    expect(observerToolKind('Bash', 'read')).toBe('execute');
  });

  it('categoria declarada fora do vocabulário não é exportada', () => {
    expect(observerToolKind('Lendo a configuração', 'rm -rf /')).toBe('other');
    expect(observerToolKind(null, 'sk-proj-SEGREDO')).toBeNull();
  });

  it('sem nome e sem categoria: null, nunca palpite', () => {
    expect(observerToolKind(null)).toBeNull();
    expect(observerToolKind(undefined)).toBeNull();
    expect(observerToolKind('   ')).toBeNull();
    expect(observerToolKind(42)).toBeNull();
    expect(observerToolKind(null, 'fetch')).toBe('fetch');
  });
});

describe('F-780: nome da skill — rótulo validado, nunca os argumentos', () => {
  it.each([
    ['ponytail', 'ponytail'],
    ['Ponytail', 'ponytail'],
    ['  impeccable  ', 'impeccable'],
    ['claude-security:scan', 'claude-security:scan'],
    ['oc_scout-2', 'oc_scout-2'],
    ['a'.repeat(80), 'a'.repeat(80)],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeSkillName(raw)).toBe(expected);
  });

  it.each([
    ['', 'vazio'],
    ['   ', 'só espaços'],
    ['Deploy Prod', 'espaço'],
    ['apps/web:deploy', 'caminho'],
    ['foo.bar', 'ponto'],
    ['-ponytail', 'começa com hífen'],
    ['a'.repeat(81), 'longo demais'],
    ['ponytail\nrm -rf /', 'quebra de linha'],
    ['sk-proj-SEGREDO', 'maiúsculas são aceitas só se o resto casar'],
  ])('%s (%s) não é gravado', (raw) => {
    // "sk-proj-segredo" casa com o padrão depois de minúsculas: o teste do
    // segredo está em quem chama (só o campo `skill` entra, nunca `args`).
    if (raw === 'sk-proj-SEGREDO') {
      expect(normalizeSkillName(raw)).toBe('sk-proj-segredo');
      return;
    }
    expect(normalizeSkillName(raw)).toBeNull();
  });

  it('só string conta', () => {
    expect(normalizeSkillName(undefined)).toBeNull();
    expect(normalizeSkillName(null)).toBeNull();
    expect(normalizeSkillName(42)).toBeNull();
    expect(normalizeSkillName({ skill: 'ponytail' })).toBeNull();
  });
});

describe('F-780: shell que faz HTTP (curl/wget) sem guardar o comando', () => {
  it.each([
    'curl -sL https://docs.example.com/api',
    '  wget -qO- https://example.com/file.json',
    'cd /tmp && curl -s https://example.com',
    'cd /tmp; curl -s https://example.com',
    'echo ok || curl -s https://example.com',
    'cat urls.txt | xargs curl -s',
    'cat body.json | curl -d @- https://api.example.com',
    'HTTPS_PROXY=http://127.0.0.1:8080 curl -s https://example.com',
    'sudo curl -s https://example.com',
    'env FOO=1 curl -s https://example.com',
    '/usr/bin/curl -s https://example.com',
    'curl.exe -s https://example.com',
    'X=$(curl -s https://example.com) && echo "$X"',
    'echo `curl -s https://example.com`',
    'npm test && curl localhost:3000/health',
    'git pull\ncurl -s https://example.com',
  ])('%s → shell-http', (command) => {
    expect(isShellHttpCommand(command)).toBe(true);
  });

  it.each([
    'npm test',
    'git commit -m "fix: curl retry"',
    "git commit -m 'fix; curl timeout'",
    'echo "use curl && wget"',
    'grep -rn curl src/',
    'cat README.md | grep wget',
    'node scripts/curl-like.js',
    'curlx --help',
    'python3 -c "import requests"',
    'cat > run.sh <<EOF\ncurl -s https://example.com\nEOF',
    // Heurística que erra para menos, documentado em F-780.md.
    'timeout 10 curl -s https://example.com',
    'bash -c "curl -s https://example.com"',
    '',
  ])('%s → não é shell-http', (command) => {
    expect(isShellHttpCommand(command)).toBe(false);
  });

  it('argv do Codex: primeiro elemento ou o script de -lc', () => {
    expect(isShellHttpCommand(['curl', '-s', 'https://example.com'])).toBe(true);
    expect(isShellHttpCommand(['bash', '-lc', 'cd app && curl -s https://example.com'])).toBe(true);
    expect(isShellHttpCommand(['bash', '-lc', 'npm test'])).toBe(false);
    expect(isShellHttpCommand([])).toBe(false);
    expect(isShellHttpCommand([42, null])).toBe(false);
    expect(isShellHttpCommand({ command: 'curl x' })).toBe(false);
    expect(isShellHttpCommand(undefined)).toBe(false);
  });

  it('só os primeiros 512 caracteres são inspecionados', () => {
    const late = `${'echo a; '.repeat(70)}curl -s https://example.com`;
    expect(late.indexOf('curl')).toBeGreaterThan(512);
    expect(isShellHttpCommand(late)).toBe(false);
    const early = `curl -s https://example.com ${'x'.repeat(5_000)}`;
    expect(isShellHttpCommand(early)).toBe(true);
  });
});

/**
 * A categoria roda a cada tool call no Main. O nome vem do agente (hook ou
 * título de ACP, este sem teto), então a classificação tem de ser linear em
 * qualquer entrada — mesmo padrão do bloco "F-764: varredura linear" de
 * limit-detector.test.ts.
 */
describe('F-780: classificação em tempo linear', () => {
  const SIZE = 16_384;
  it.each([
    ['nome gigante sem separador', 'a'.repeat(SIZE)],
    ['só sublinhados', '_'.repeat(SIZE)],
    ['sublinhados duplos', '__'.repeat(SIZE / 2)],
    ['prefixo mcp repetido', 'mcp__'.repeat(SIZE / 5)],
    ['espaços e pontuação', ' .:-'.repeat(SIZE / 4)],
    ['nexus_ repetido', 'nexus_'.repeat(Math.floor(SIZE / 6))],
  ])('%s: termina em tempo linear', (_label, name) => {
    // Aquece: compilação/tier-up não é o que está sendo medido.
    observerToolKind(name);
    const startedAt = performance.now();
    const kind = observerToolKind(name);
    const elapsedMs = performance.now() - startedAt;
    expect(kind).not.toBeNull();
    expect(elapsedMs).toBeLessThan(50);
  });

  it.each([
    ['aspas abertas sem fechar', `"${'a'.repeat(SIZE)}`],
    ['só separadores', ';'.repeat(SIZE)],
    ['só barras invertidas', '\\'.repeat(SIZE)],
    ['atribuições de ambiente', 'A=1 '.repeat(SIZE / 4)],
    ['wrappers encadeados', 'sudo '.repeat(SIZE / 5)],
    ['uma palavra gigante', 'x'.repeat(SIZE)],
    ['quebras de linha', '\n'.repeat(SIZE)],
    ['heredoc no fim', `${'echo a && '.repeat(40)}<<EOF${'\ncurl'.repeat(500)}`],
  ])('comando adversarial (%s): termina em tempo linear', (_label, command) => {
    isShellHttpCommand(command);
    const startedAt = performance.now();
    isShellHttpCommand(command);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(50);
  });

  it.each([
    ['nome de skill gigante', 'a'.repeat(SIZE)],
    ['dois-pontos repetidos', ':'.repeat(SIZE)],
    ['quase válido com espaço no fim', `${'a'.repeat(79)}${' '.repeat(SIZE)}`],
  ])('skill adversarial (%s): termina em tempo linear', (_label, raw) => {
    normalizeSkillName(raw);
    const startedAt = performance.now();
    normalizeSkillName(raw);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(50);
  });
});
