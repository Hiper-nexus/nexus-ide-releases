import { describe, expect, it } from 'vitest';
import { observerToolKind } from './observer-tool-kind';

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
});
