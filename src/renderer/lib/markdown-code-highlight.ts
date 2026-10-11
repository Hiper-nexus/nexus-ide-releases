/**
 * Realce de sintaxe dos blocos cercados do `MarkdownView` (F-1176): decide
 * QUANDO realçar. O COMO é o mesmo do diff (@pierre/diffs + Shiki, worker
 * pool compartilhado) e mora em `components/MarkdownCodeHighlight.tsx`,
 * carregado sob demanda.
 *
 * Só linguagens desta lista (todas do pacote do Shiki): uma cerca com nome
 * desconhecido fica texto puro, sem tentar adivinhar. `mermaid` não entra —
 * esses blocos viram diagrama na `MarkdownWithMermaid`.
 */

/** Texto de agente acima disto fica `<pre><code>` puro: o realce não paga. */
export const MARKDOWN_HIGHLIGHT_MAX_CHARS = 20_000;
export const MARKDOWN_HIGHLIGHT_MAX_LINES = 400;
/** Até isto o realce pode demorar para carregar; depois, fica o texto puro. */
export const MARKDOWN_HIGHLIGHT_TIMEOUT_MS = 3_000;

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'jsonc',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  shellscript: 'shellscript',
  console: 'shellscript',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  java: 'java',
  kt: 'kotlin',
  kotlin: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cs: 'csharp',
  csharp: 'csharp',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  html: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  ps1: 'powershell',
  powershell: 'powershell',
};

/** A linguagem do Shiki para a cerca, ou `null` quando o bloco fica puro. */
export function markdownHighlightLanguage(language: string, text: string): string | null {
  const key = language.trim().toLowerCase();
  if (!key || !Object.prototype.hasOwnProperty.call(LANGUAGES, key)) return null;
  if (text.length > MARKDOWN_HIGHLIGHT_MAX_CHARS) return null;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    lines += 1;
    if (lines > MARKDOWN_HIGHLIGHT_MAX_LINES) return null;
  }
  return LANGUAGES[key] ?? null;
}

/** Rejeita se `load` não chegar em `ms`; o chamador fica no texto puro. */
export function withHighlightTimeout<T>(load: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Realce demorou mais de ${ms} ms`)), ms);
    load.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
