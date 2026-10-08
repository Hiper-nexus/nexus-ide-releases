// F-1014: Git (status + diff) e arquivos (lista + leitura) de um pane do desktop
// Nexus, pela Remote Bridge. Só leitura — stage, commit, checkout e escrita
// continuam "não disponível em host Nexus". TS puro: o teste de ponta a ponta do
// desktop importa este módulo por caminho, junto com o adaptador.
//
//   git.status  {paneId}                          → bridge git.status
//   git.diff    {paneId, filePath, staged|area}   → bridge git.diff
//   files.list  {paneId, path?}                   → bridge files.list
//   files.read  {paneId, relativePath}            → bridge files.read
//
// `paneId` também é aceito como `worktree` (`id:<paneId>`), o nome que as telas
// do Orca usam. A autoridade (pane visível ao aparelho, realpath dentro do
// checkout, `.git`/segredos recusados, limites de tamanho) é do desktop
// (src/main/remote/remote-workspace-rpc.ts); aqui só se traduz e se valida a forma.
import type { MobileDiffLine } from '../session/mobile-diff-lines'
import type { MobileGitFileStatus, MobileGitStagingArea } from '../source-control/mobile-git-status'
import { NexusBridgeRemoteError, type NexusBridgeRequestOptions } from './nexus-bridge-client'

export type NexusBridgeRequest = (
  type: string,
  fields?: Record<string, unknown>,
  options?: NexusBridgeRequestOptions
) => Promise<unknown>

export type NexusGitStatusEntry = {
  readonly path: string
  readonly oldPath?: string
  readonly status: MobileGitFileStatus
  readonly area: MobileGitStagingArea
  /** Letra do porcelain como o desktop mostra (M, A, D, R, C, U, ?). */
  readonly letter: string
  readonly conflictStatus?: 'unresolved'
  /** O desktop não entrega o conteúdo deste arquivo ao celular (`.git`, segredo). */
  readonly restricted: boolean
}

/** Compatível com `readMobileGitStatusResult` (entries/branch/upstreamStatus). */
export type NexusGitStatus = {
  readonly entries: readonly NexusGitStatusEntry[]
  readonly branch?: string
  readonly upstreamStatus: { readonly hasUpstream: boolean; readonly ahead: number; readonly behind: number }
  readonly conflictOperation: 'unknown'
  readonly clean: boolean
  readonly truncated: boolean
}

export type NexusGitDiff =
  | {
      readonly kind: 'patch'
      readonly path: string
      readonly staged: boolean
      readonly patch: string
      readonly truncated: boolean
    }
  | { readonly kind: 'binary'; readonly path: string; readonly staged: boolean }
  | {
      readonly kind: 'untracked'
      readonly path: string
      readonly content: string
      readonly truncated: boolean
      readonly binary: boolean
      readonly byteLength: number
    }

export type NexusFileEntry = { readonly name: string; readonly path: string; readonly kind: 'file' | 'dir' }

export type NexusFileList = {
  readonly path: string
  readonly entries: readonly NexusFileEntry[]
  readonly truncated: boolean
}

/** Mesma forma do `files.read` do Orca ({content, truncated, byteLength}) + `binary`. */
export type NexusFileRead = {
  readonly path: string
  readonly content: string
  readonly truncated: boolean
  readonly byteLength: number
  readonly binary: boolean
}

export type NexusWorkspaceApi = {
  gitStatus: (paneId: string) => Promise<NexusGitStatus>
  gitDiff: (paneId: string, entry: Pick<NexusGitStatusEntry, 'path' | 'area'>) => Promise<NexusGitDiff>
  listFiles: (paneId: string, path?: string) => Promise<NexusFileList>
  readFile: (paneId: string, path: string) => Promise<NexusFileRead>
}

/** Recusa de forma (parâmetro ausente, resposta inválida): vira falha do host. */
export class NexusWorkspaceShapeError extends NexusBridgeRemoteError {}

export const NEXUS_GIT_FILES_METHODS: ReadonlySet<string> = new Set([
  'git.status',
  'git.diff',
  'files.list',
  'files.read'
])

/** Linhas de diff mostradas no celular (o mesmo teto do preview do Orca). */
export const NEXUS_DIFF_MAX_LINES = 2_500

const STATUS_BY_LETTER: Record<string, MobileGitFileStatus> = {
  M: 'modified',
  T: 'modified',
  U: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  '?': 'untracked'
}

export function createNexusWorkspaceApi(request: NexusBridgeRequest): NexusWorkspaceApi {
  return {
    gitStatus: async (paneId) => readNexusGitStatus(await request('git.status', { paneId })),
    gitDiff: async (paneId, entry) =>
      readNexusGitDiff(
        await request('git.diff', {
          paneId,
          path: entry.path,
          staged: entry.area === 'staged',
          untracked: entry.area === 'untracked'
        })
      ),
    listFiles: async (paneId, path = '') =>
      readNexusFileList(await request('files.list', { paneId, path })),
    readFile: async (paneId, path) => readNexusFileRead(await request('files.read', { paneId, path }))
  }
}

/**
 * Métodos do app (nomes do Orca) → API acima. `handled: false` = não é deste
 * módulo; o adaptador decide (normalmente "não disponível em host Nexus").
 */
export async function routeNexusGitFiles(
  method: string,
  params: Record<string, unknown>,
  api: NexusWorkspaceApi
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  if (!NEXUS_GIT_FILES_METHODS.has(method)) {
    return { handled: false }
  }
  const paneId = paneIdOf(params)
  switch (method) {
    case 'git.status':
      return { handled: true, result: await api.gitStatus(paneId) }
    case 'git.diff': {
      const path = stringParam(params.filePath ?? params.path, 'filePath')
      const area: MobileGitStagingArea =
        params.area === 'untracked' || params.untracked === true
          ? 'untracked'
          : params.area === 'staged' || params.staged === true
            ? 'staged'
            : 'unstaged'
      return { handled: true, result: await api.gitDiff(paneId, { path, area }) }
    }
    case 'files.list': {
      const path = params.path ?? params.relativePath
      return { handled: true, result: await api.listFiles(paneId, typeof path === 'string' ? path : '') }
    }
    default:
      return {
        handled: true,
        result: await api.readFile(paneId, stringParam(params.relativePath ?? params.path, 'relativePath'))
      }
  }
}

function paneIdOf(params: Record<string, unknown>): string {
  if (typeof params.paneId === 'string' && params.paneId) {
    return params.paneId
  }
  if (typeof params.worktree === 'string' && params.worktree) {
    return params.worktree.replace(/^(?:id|pane):/, '')
  }
  throw new NexusWorkspaceShapeError('parâmetro paneId ausente')
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new NexusWorkspaceShapeError(`parâmetro ${name} ausente`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readEntries(value: unknown, area: MobileGitStagingArea): NexusGitStatusEntry[] {
  return arrayOf(value).flatMap((change): NexusGitStatusEntry[] => {
    if (typeof change.path !== 'string' || !change.path) {
      return []
    }
    const letter = typeof change.status === 'string' && change.status ? change.status : '?'
    return [
      {
        path: change.path,
        ...(typeof change.originalPath === 'string' ? { oldPath: change.originalPath } : {}),
        status: area === 'untracked' ? 'untracked' : (STATUS_BY_LETTER[letter] ?? 'modified'),
        area,
        letter,
        ...(letter === 'U' ? { conflictStatus: 'unresolved' as const } : {}),
        restricted: change.restricted === true
      }
    ]
  })
}

export function readNexusGitStatus(raw: unknown): NexusGitStatus {
  if (!isRecord(raw)) {
    throw new NexusWorkspaceShapeError('resposta de git.status inválida')
  }
  return {
    entries: [
      ...readEntries(raw.staged, 'staged'),
      ...readEntries(raw.unstaged, 'unstaged'),
      ...readEntries(raw.untracked, 'untracked')
    ],
    ...(typeof raw.branch === 'string' ? { branch: raw.branch } : {}),
    upstreamStatus: {
      hasUpstream: raw.hasUpstream === true,
      ahead: numberOr(raw.ahead, 0),
      behind: numberOr(raw.behind, 0)
    },
    conflictOperation: 'unknown',
    clean: raw.clean === true,
    truncated: raw.truncated === true
  }
}

export function readNexusGitDiff(raw: unknown): NexusGitDiff {
  if (!isRecord(raw) || typeof raw.path !== 'string') {
    throw new NexusWorkspaceShapeError('resposta de git.diff inválida')
  }
  const staged = raw.staged === true
  if (raw.kind === 'binary') {
    return { kind: 'binary', path: raw.path, staged }
  }
  if (raw.kind === 'untracked') {
    return {
      kind: 'untracked',
      path: raw.path,
      content: typeof raw.content === 'string' ? raw.content : '',
      truncated: raw.truncated === true,
      binary: raw.binary === true,
      byteLength: numberOr(raw.byteLength, 0)
    }
  }
  if (raw.kind === 'patch' && typeof raw.patch === 'string') {
    return { kind: 'patch', path: raw.path, staged, patch: raw.patch, truncated: raw.truncated === true }
  }
  throw new NexusWorkspaceShapeError('resposta de git.diff inválida')
}

export function readNexusFileList(raw: unknown): NexusFileList {
  if (!isRecord(raw)) {
    throw new NexusWorkspaceShapeError('resposta de files.list inválida')
  }
  return {
    path: typeof raw.path === 'string' ? raw.path : '',
    entries: arrayOf(raw.entries).flatMap((entry): NexusFileEntry[] =>
      typeof entry.name === 'string' &&
      typeof entry.path === 'string' &&
      (entry.kind === 'file' || entry.kind === 'dir')
        ? [{ name: entry.name, path: entry.path, kind: entry.kind }]
        : []
    ),
    truncated: raw.truncated === true
  }
}

export function readNexusFileRead(raw: unknown): NexusFileRead {
  if (!isRecord(raw) || typeof raw.path !== 'string') {
    throw new NexusWorkspaceShapeError('resposta de files.read inválida')
  }
  return {
    path: raw.path,
    content: typeof raw.content === 'string' ? raw.content : '',
    truncated: raw.truncated === true,
    byteLength: numberOr(raw.byteLength, 0),
    binary: raw.binary === true
  }
}

/**
 * Patch unificado (`git diff`) → linhas do componente de diff do app. O
 * cabeçalho de cada hunk vira uma linha de contexto sem número (não comentável).
 */
export function parseNexusUnifiedPatch(
  patch: string,
  maxLines = NEXUS_DIFF_MAX_LINES
): { lines: MobileDiffLine[]; truncated: boolean } {
  const lines: MobileDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    if (lines.length >= maxLines) {
      return { lines, truncated: true }
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      lines.push({ kind: 'context', text: raw })
      continue
    }
    if (!inHunk || raw.startsWith('\\')) {
      continue // cabeçalhos do arquivo e "\ No newline at end of file"
    }
    const marker = raw[0]
    const text = raw.slice(1)
    if (marker === '+') {
      lines.push({ kind: 'add', text, newLineNumber: newLine++ })
    } else if (marker === '-') {
      lines.push({ kind: 'delete', text, oldLineNumber: oldLine++ })
    } else if (marker === ' ') {
      lines.push({ kind: 'context', text, oldLineNumber: oldLine++, newLineNumber: newLine++ })
    } else {
      inHunk = false // `diff --git` do arquivo seguinte ou o aviso de corte do desktop
    }
  }
  return { lines, truncated: false }
}

/** Linhas de um diff para o componente de diff do app (arquivo novo = tudo adição). */
export function nexusDiffLines(diff: NexusGitDiff): { lines: MobileDiffLine[]; truncated: boolean } {
  if (diff.kind === 'binary') {
    return { lines: [], truncated: false }
  }
  if (diff.kind === 'untracked') {
    const content = diff.content.endsWith('\n') ? diff.content.slice(0, -1) : diff.content
    const all = content ? content.split(/\r?\n/) : []
    const shown = all.slice(0, NEXUS_DIFF_MAX_LINES)
    return {
      lines: shown.map((text, index) => ({ kind: 'add', text, newLineNumber: index + 1 })),
      truncated: diff.truncated || all.length > shown.length
    }
  }
  const parsed = parseNexusUnifiedPatch(diff.patch)
  return { lines: parsed.lines, truncated: parsed.truncated || diff.truncated }
}

const REFUSAL_TEXT: ReadonlyArray<readonly [pattern: RegExp, text: string]> = [
  [/secret-file/, 'Arquivo sensível (.env, chave, credencial): o desktop não envia o conteúdo ao celular.'],
  [/git-internals/, 'Arquivos internos do Git (.git/) não são abertos pelo celular.'],
  [/path-escapes-checkout|symbolic link/, 'Link simbólico para fora do checkout: o desktop recusou abrir.'],
  [/parent-traversal|absolute-path|invalid-path/, 'Caminho inválido: só caminhos dentro do checkout do pane.'],
  [/pane-has-no-checkout/, 'Este pane não tem checkout (pane de navegador).'],
  [/checkout-identity-changed|checkout is unavailable/, 'O checkout deste pane não está mais no disco do desktop.'],
  [/pane not found/, 'O pane não existe mais no desktop.'],
  [/not authorized/, 'Este aparelho não tem acesso a este pane.'],
  [/not a git repository/i, 'O checkout deste pane não é um repositório Git.'],
  [/is a directory|not a regular file/, 'Não é um arquivo comum.']
]

/** Texto para a tela a partir da recusa do desktop (mensagens da bridge são em inglês). */
export function nexusWorkspaceErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return REFUSAL_TEXT.find(([pattern]) => pattern.test(message))?.[1] ?? message
}
