// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: JavaScript engine only (no native
// engine, no Effect), Nexus theme colors, every grammar lazy, a curated language list (JS/JSX
// via TSX, C++ via C, others stay plain), rows highlighted per 200-row block with an LRU cache
// and grammar state carried between blocks (technique from incrementalSnippet.ts).
import {
  createHighlighterCore,
  type GrammarState,
  type HighlighterCore,
  type ThemedToken
} from '@shikijs/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { detectMobileFileLanguage } from '../session/mobile-file-language'
import {
  MOBILE_REVIEW_SHIKI_THEME_NAME,
  mobileReviewShikiTheme
} from '../theme/mobile-review-shiki-theme'
import type { MobileReviewLineRow, MobileReviewToken } from './mobile-review-model'
import { applyDiffRangesToTokens, computeWordAltDiffRanges } from './mobile-review-word-diff'

const REVIEW_HIGHLIGHT_CHUNK_LINE_THRESHOLD = 8
export const MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE = 200
export const MOBILE_REVIEW_TOKENIZE_MAX_LINE_LENGTH = 1_000
export const MOBILE_REVIEW_HIGHLIGHT_CACHE_LIMIT = 48

const loadedLanguages = new Set<string>(['text'])
const languageLoadingPromises = new Map<string, Promise<boolean>>()
// Why: Metro puts every import() target in the same bundle, so this is a curated
// list of the languages most common in the operator's repositories; anything else
// renders as plain text. JavaScript/JSX use the TSX grammar and C++ the C grammar
// (see languageAliases) so their own grammars stay out of the list. Ruby stays out
// too: its grammar embeds cpp and graphql (which embeds js/jsx/ts/tsx), ~0.9 MB.
const languageImports: Partial<Record<string, () => Promise<unknown>>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  json: () => import('@shikijs/langs/json'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  html: () => import('@shikijs/langs/html'),
  markdown: () => import('@shikijs/langs/markdown'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  java: () => import('@shikijs/langs/java'),
  php: () => import('@shikijs/langs/php'),
  c: () => import('@shikijs/langs/c'),
  csharp: () => import('@shikijs/langs/csharp'),
  docker: () => import('@shikijs/langs/docker'),
  diff: () => import('@shikijs/langs/diff')
}

const languageAliases: Record<string, string> = {
  javascript: 'tsx',
  jsx: 'tsx',
  js: 'tsx',
  mjs: 'tsx',
  cjs: 'tsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shellscript',
  zsh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  cpp: 'c',
  'c++': 'c',
  'c#': 'csharp',
  cs: 'csharp',
  dockerfile: 'docker',
  plain: 'text',
  plaintext: 'text',
  txt: 'text'
}

// Why: the Nexus detector folds these into lowlight-friendly names (or does not
// know them); Shiki has dedicated grammars for them.
const EXTENSION_LANGUAGE_OVERRIDES: Record<string, string> = {
  '.tsx': 'tsx',
  '.toml': 'toml',
  '.diff': 'diff',
  '.patch': 'diff'
}

let highlighterPromise: Promise<HighlighterCore> | null = null

type LoadedLanguageModule = {
  default: Parameters<HighlighterCore['loadLanguage']>[0]
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const configuredHighlighterPromise = createHighlighterCore({
      themes: [mobileReviewShikiTheme],
      langs: [],
      // Why: no native engine on Nexus mobile; skip grammar patterns Hermes cannot
      // compile instead of failing the whole highlighter.
      engine: createJavaScriptRegexEngine({ forgiving: true })
    })
    highlighterPromise = configuredHighlighterPromise.catch((error: unknown) => {
      highlighterPromise = null
      throw error
    })
  }
  return highlighterPromise
}

function resolveLanguageAlias(language: string): string {
  const normalized = language.toLowerCase()
  return languageAliases[normalized] ?? normalized
}

function extensionOverride(filePath: string): string | undefined {
  const lastDot = filePath.lastIndexOf('.')
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastDot > lastSlash
    ? EXTENSION_LANGUAGE_OVERRIDES[filePath.slice(lastDot).toLowerCase()]
    : undefined
}

export function resolveMobileReviewLanguage(
  filePath: string,
  languageHint: string | null = null
): string {
  const detectedLanguage =
    languageHint ?? extensionOverride(filePath) ?? detectMobileFileLanguage(filePath)
  const candidate = resolveLanguageAlias(detectedLanguage)
  if (candidate === 'text' || candidate === 'ansi' || !(candidate in languageImports)) {
    return 'text'
  }
  return candidate
}

async function loadSingleLanguage(
  highlighter: HighlighterCore,
  language: string
): Promise<boolean> {
  if (loadedLanguages.has(language)) {
    return true
  }

  const existingPromise = languageLoadingPromises.get(language)
  if (existingPromise) {
    return existingPromise
  }

  const importer = languageImports[language]
  if (!importer) {
    return false
  }

  const loadingPromise = (async () => {
    try {
      const languageModule = (await importer()) as LoadedLanguageModule
      await highlighter.loadLanguage(languageModule.default)
      loadedLanguages.add(language)
      return true
    } catch {
      return false
    } finally {
      languageLoadingPromises.delete(language)
    }
  })()

  languageLoadingPromises.set(language, loadingPromise)
  return loadingPromise
}

type RawHighlightedLine = ReadonlyArray<Pick<ThemedToken, 'content' | 'color' | 'fontStyle'>>

function normalizeHighlightedLine(line: RawHighlightedLine): MobileReviewToken[] {
  return line.map((token) => ({
    content: token.content,
    color: token.color ?? null,
    fontStyle: token.fontStyle ?? null
  }))
}

function plainLineTokens(text: string): MobileReviewToken[] {
  return text.length === 0 ? [] : [{ content: text, color: null, fontStyle: null }]
}

type HighlightedSide = {
  readonly lines: ReadonlyArray<ReadonlyArray<MobileReviewToken>>
  readonly state: GrammarState | undefined
}

async function highlightLines(
  highlighter: HighlighterCore,
  sourceLines: readonly string[],
  language: string,
  startState: GrammarState | undefined
): Promise<HighlightedSide> {
  const highlightedLines: Array<ReadonlyArray<MobileReviewToken>> = []
  const shortLineBatch: string[] = []
  let state = startState

  const flushShortLineBatch = (): void => {
    if (shortLineBatch.length === 0) {
      return
    }

    const tokenLines = highlighter.codeToTokensBase(shortLineBatch.join('\n'), {
      lang: language,
      theme: MOBILE_REVIEW_SHIKI_THEME_NAME,
      ...(state ? { grammarState: state } : {})
    })
    state = highlighter.getLastGrammarState(tokenLines) ?? state
    // Why: a row may only ever receive its own tokens; if the tokenizer ever
    // returns a different line count, keep this batch plain instead of shifting rows.
    if (tokenLines.length === shortLineBatch.length) {
      highlightedLines.push(...tokenLines.map(normalizeHighlightedLine))
    } else {
      highlightedLines.push(...shortLineBatch.map(plainLineTokens))
    }
    shortLineBatch.length = 0
  }

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex] ?? ''

    if (line.length > MOBILE_REVIEW_TOKENIZE_MAX_LINE_LENGTH) {
      flushShortLineBatch()
      highlightedLines.push(plainLineTokens(line))
    } else {
      shortLineBatch.push(line)
    }

    if (shortLineBatch.length >= MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE) {
      flushShortLineBatch()
    }

    if (
      sourceLines.length > REVIEW_HIGHLIGHT_CHUNK_LINE_THRESHOLD &&
      lineIndex + 1 < sourceLines.length &&
      (shortLineBatch.length === 0 || line.length > MOBILE_REVIEW_TOKENIZE_MAX_LINE_LENGTH)
    ) {
      await waitForNextFrame()
    }
  }

  flushShortLineBatch()

  return { lines: highlightedLines, state }
}

function applyWordAltDiffHighlightsToBlock(
  rows: ReadonlyArray<MobileReviewLineRow>,
  start: number,
  tokens: ReadonlyArray<ReadonlyArray<MobileReviewToken>>
): ReadonlyArray<ReadonlyArray<MobileReviewToken>> {
  const nextTokens = [...tokens]
  const rangesByPair = new Map<string, ReturnType<typeof computeWordAltDiffRanges>>()

  nextTokens.forEach((lineTokens, offset) => {
    const rowIndex = start + offset
    const row = rows[rowIndex]
    if (!row || row.kind === 'context' || row.pairIndex === null) {
      return
    }
    const pairedRow = rows[row.pairIndex]
    if (!pairedRow) {
      return
    }

    const pairKey = `${Math.min(rowIndex, row.pairIndex)}:${Math.max(rowIndex, row.pairIndex)}`
    let ranges = rangesByPair.get(pairKey)
    if (!ranges) {
      ranges = computeWordAltDiffRanges({
        deletionLine: row.kind === 'delete' ? row.text : pairedRow.text,
        additionLine: row.kind === 'add' ? row.text : pairedRow.text
      })
      rangesByPair.set(pairKey, ranges)
    }

    const sideRanges = row.kind === 'delete' ? ranges.deletion : ranges.addition
    if (sideRanges.length > 0) {
      nextTokens[offset] = applyDiffRangesToTokens(lineTokens, sideRanges)
    }
  })

  return nextTokens
}

type CachedBlock = {
  readonly tokens: ReadonlyArray<ReadonlyArray<MobileReviewToken>>
  readonly additionState: GrammarState | undefined
  readonly deletionState: GrammarState | undefined
}

const blockCache = new Map<string, CachedBlock>()
const pendingBlocks = new Map<string, Promise<CachedBlock>>()

function readBlockCache(key: string): CachedBlock | undefined {
  const cached = blockCache.get(key)
  if (cached) {
    blockCache.delete(key)
    blockCache.set(key, cached)
  }
  return cached
}

function writeBlockCache(key: string, block: CachedBlock): void {
  blockCache.delete(key)
  blockCache.set(key, block)
  while (blockCache.size > MOBILE_REVIEW_HIGHLIGHT_CACHE_LIMIT) {
    const oldestKey = blockCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    blockCache.delete(oldestKey)
  }
}

export function mobileReviewBlockCount(rowCount: number): number {
  return Math.ceil(Math.max(0, rowCount) / MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE)
}

export function mobileReviewBlockRange(
  blockIndex: number,
  rowCount: number
): { readonly start: number; readonly end: number } {
  const start = blockIndex * MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE
  return { start, end: Math.min(rowCount, start + MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE) }
}

/** Blocks covering the visible rows plus `lookahead` blocks below them. */
export function mobileReviewBlocksForWindow(
  firstVisibleIndex: number,
  lastVisibleIndex: number,
  rowCount: number,
  lookahead = 1
): number[] {
  const blockCount = mobileReviewBlockCount(rowCount)
  if (blockCount === 0) {
    return []
  }
  const clampBlock = (index: number) =>
    Math.min(blockCount - 1, Math.max(0, Math.floor(index / MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE)))
  const first = clampBlock(Math.min(firstVisibleIndex, lastVisibleIndex))
  const last = Math.min(
    blockCount - 1,
    clampBlock(Math.max(firstVisibleIndex, lastVisibleIndex)) + Math.max(0, lookahead)
  )
  const blocks: number[] = []
  for (let block = first; block <= last; block += 1) {
    blocks.push(block)
  }
  return blocks
}

export type MobileReviewBlockInput = {
  readonly cacheKey: string
  readonly filePath: string
  readonly languageHint?: string | null
  readonly rows: ReadonlyArray<MobileReviewLineRow>
  readonly blockIndex: number
}

function blockCacheKey(input: MobileReviewBlockInput, language: string, blockIndex: number) {
  return `${input.cacheKey}\0${language}\0${blockIndex}`
}

/** Synchronous cache read so a re-opened file paints colors on its first frame. */
export function readMobileReviewHighlightedBlock(
  input: MobileReviewBlockInput
): ReadonlyArray<ReadonlyArray<MobileReviewToken>> | undefined {
  const language = resolveMobileReviewLanguage(input.filePath, input.languageHint ?? null)
  return readBlockCache(blockCacheKey(input, language, input.blockIndex))?.tokens
}

async function tokenizeBlock(
  input: MobileReviewBlockInput,
  language: string,
  blockRows: ReadonlyArray<MobileReviewLineRow>
): Promise<CachedBlock> {
  if (language === 'text') {
    return {
      tokens: blockRows.map((row) => plainLineTokens(row.text)),
      additionState: undefined,
      deletionState: undefined
    }
  }

  const highlighter = await getHighlighter()
  const loaded = await loadSingleLanguage(highlighter, language)
  if (!loaded) {
    return {
      tokens: blockRows.map((row) => plainLineTokens(row.text)),
      additionState: undefined,
      deletionState: undefined
    }
  }

  // Why: each side is tokenized as a whole file — context + added rows are the new
  // file, context + deleted rows the old one — so a deleted row inside a comment or
  // string opened on a context row reads as such. Each side keeps its own grammar
  // state, continued from the previous block; context rows show the new-file tokens.
  const previous = readBlockCache(blockCacheKey(input, language, input.blockIndex - 1))
  const newFileLines: string[] = []
  const oldFileLines: string[] = []
  for (const row of blockRows) {
    if (row.kind !== 'delete') {
      newFileLines.push(row.text)
    }
    if (row.kind !== 'add') {
      oldFileLines.push(row.text)
    }
  }
  const [additionSide, deletionSide] = await Promise.all([
    highlightLines(highlighter, newFileLines, language, previous?.additionState),
    highlightLines(highlighter, oldFileLines, language, previous?.deletionState)
  ])

  let additionIndex = 0
  let deletionIndex = 0
  const tokens = blockRows.map((row) => {
    if (row.kind === 'delete') {
      const lineTokens = deletionSide.lines[deletionIndex] ?? plainLineTokens(row.text)
      deletionIndex += 1
      return lineTokens
    }
    if (row.kind === 'context') {
      deletionIndex += 1
    }
    const lineTokens = additionSide.lines[additionIndex] ?? plainLineTokens(row.text)
    additionIndex += 1
    return lineTokens
  })

  return { tokens, additionState: additionSide.state, deletionState: deletionSide.state }
}

/**
 * Highlights one 200-row block of a review file. Lines longer than 1000
 * characters stay raw text, and paired delete/add rows get word-diff ranges.
 */
export async function highlightMobileReviewBlock(
  input: MobileReviewBlockInput
): Promise<ReadonlyArray<ReadonlyArray<MobileReviewToken>>> {
  const language = resolveMobileReviewLanguage(input.filePath, input.languageHint ?? null)
  const key = blockCacheKey(input, language, input.blockIndex)
  const cached = readBlockCache(key)
  if (cached) {
    return cached.tokens
  }
  const pending = pendingBlocks.get(key)
  if (pending) {
    return (await pending).tokens
  }

  const { start, end } = mobileReviewBlockRange(input.blockIndex, input.rows.length)
  const blockRows = input.rows.slice(start, end)
  const work = (async () => {
    let block: CachedBlock
    try {
      block = await tokenizeBlock(input, language, blockRows)
    } catch {
      block = {
        tokens: blockRows.map((row) => plainLineTokens(row.text)),
        additionState: undefined,
        deletionState: undefined
      }
    }
    const withWordDiffs: CachedBlock = {
      ...block,
      tokens: applyWordAltDiffHighlightsToBlock(input.rows, start, block.tokens)
    }
    writeBlockCache(key, withWordDiffs)
    return withWordDiffs
  })()

  pendingBlocks.set(key, work)
  try {
    return (await work).tokens
  } finally {
    pendingBlocks.delete(key)
  }
}
