// F-1014: "Alterações" (git status → diff) e "Arquivos" (lista → leitura) do
// checkout de um pane do desktop Nexus. Só leitura: não há stage, commit nem
// edição aqui. As linhas do diff usam o mesmo componente da revisão do app
// (MobileDiffReviewLine, com realce de sintaxe por bloco).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronLeft, ChevronRight, FileText, Folder, Lock, RefreshCw } from 'lucide-react-native'
import { MobileDiffReviewLine } from '../components/MobileDiffReviewLine'
// MOB-01: a lista virtualizada do app (a mesma do caminho Orca).
import { MobileLegendList } from '../components/MobileLegendList'
import { useMobileDiffReviewBlockHighlights } from '../session/use-mobile-diff-review-block-highlights'
import { buildMobileReviewLines, type MobileReviewLineRow } from '../source-control/mobile-review-model'
import {
  nexusDiffLines,
  nexusWorkspaceErrorText,
  type NexusFileEntry,
  type NexusFileList,
  type NexusFileRead,
  type NexusGitDiff,
  type NexusGitStatus,
  type NexusGitStatusEntry,
  type NexusWorkspaceApi
} from '../transport/nexus-bridge-git-files'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export type NexusWorkspaceView = 'changes' | 'files'

type Load<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly value: T }

const NO_COMMENTS: never[] = []
const NO_STALE: ReadonlySet<string> = new Set()
const noop = () => undefined

const AREA_TITLE: Record<NexusGitStatusEntry['area'], string> = {
  staged: 'Preparadas para commit',
  unstaged: 'Alteradas',
  untracked: 'Novas (fora do Git)'
}
// F-1037: a mesma ordem do painel Git do desktop — Preparadas, Alteradas, Novas.
export const NEXUS_GIT_AREA_ORDER: readonly NexusGitStatusEntry['area'][] = [
  'staged',
  'unstaged',
  'untracked'
]

/** Carrega `load()` e recarrega quando a chave muda ou em `reload()`. */
function useLoad<T>(key: string, load: () => Promise<T>): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    load().then(
      (value) => !cancelled && setState({ kind: 'ready', value }),
      (error: unknown) => !cancelled && setState({ kind: 'error', message: nexusWorkspaceErrorText(error) })
    )
    return () => {
      cancelled = true
    }
    // `load` muda a cada render; a chave e a tentativa dizem quando recarregar.
  }, [key, attempt])
  return [state, useCallback(() => setAttempt((value) => value + 1), [])]
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024).toLocaleString('pt-BR')} KB`
}

/** Os dois atalhos do detalhe do pane. */
export function NexusWorkspaceOpeners({
  onOpen,
  disabled
}: {
  onOpen: (view: NexusWorkspaceView) => void
  disabled: boolean
}) {
  return (
    <View style={styles.openers}>
      <Pressable
        style={({ pressed }) => [styles.opener, pressed && styles.pressed, disabled && styles.disabled]}
        onPress={() => onOpen('changes')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Abrir alterações do Git deste pane"
      >
        <Text style={styles.openerText}>Alterações</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.opener, pressed && styles.pressed, disabled && styles.disabled]}
        onPress={() => onOpen('files')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Abrir arquivos do checkout deste pane"
      >
        <Text style={styles.openerText}>Arquivos</Text>
      </Pressable>
    </View>
  )
}

export function NexusPaneWorkspace({
  paneId,
  workspace,
  view,
  onViewChange
}: {
  paneId: string
  workspace: NexusWorkspaceApi
  view: NexusWorkspaceView
  onViewChange: (view: NexusWorkspaceView) => void
}) {
  return (
    <View style={styles.container}>
      <View style={styles.segment} accessibilityRole="tablist">
        {(['changes', 'files'] as const).map((item) => (
          <Pressable
            key={item}
            style={[styles.segmentItem, view === item && styles.segmentItemActive]}
            onPress={() => onViewChange(item)}
            accessibilityRole="tab"
            accessibilityState={{ selected: view === item }}
          >
            <Text style={[styles.segmentText, view === item && styles.segmentTextActive]}>
              {item === 'changes' ? 'Alterações' : 'Arquivos'}
            </Text>
          </Pressable>
        ))}
      </View>
      {view === 'changes' ? (
        <NexusChanges paneId={paneId} workspace={workspace} />
      ) : (
        <NexusFiles paneId={paneId} workspace={workspace} />
      )}
      <Text style={styles.note}>Somente leitura: stage, commit e edição continuam no desktop.</Text>
    </View>
  )
}

// ---------------------------------------------------------------- Alterações

function NexusChanges({ paneId, workspace }: { paneId: string; workspace: NexusWorkspaceApi }) {
  const [status, reload] = useLoad<NexusGitStatus>(`status:${paneId}`, () => workspace.gitStatus(paneId))
  const [open, setOpen] = useState<NexusGitStatusEntry | null>(null)

  if (open) {
    return (
      <NexusDiff paneId={paneId} workspace={workspace} entry={open} onBack={() => setOpen(null)} />
    )
  }
  if (status.kind !== 'ready') {
    return <LoadState state={status} busyText="Lendo o git status no desktop…" onRetry={reload} />
  }
  const { entries, branch, upstreamStatus, truncated } = status.value
  return (
    <MobileLegendList
      data={NEXUS_GIT_AREA_ORDER.flatMap((area) => {
        const rows = entries.filter((entry) => entry.area === area)
        return rows.length > 0 ? [{ area, rows }] : []
      })}
      keyExtractor={(section) => section.area}
      estimatedItemSize={160}
      ListHeaderComponent={
        <View style={styles.toolbar}>
          <Text style={styles.toolbarText} numberOfLines={1}>
            {branch ? `branch ${branch}` : 'HEAD destacado'}
            {upstreamStatus.hasUpstream
              ? ` · ${upstreamStatus.ahead} à frente, ${upstreamStatus.behind} atrás`
              : ' · sem upstream'}
          </Text>
          <RefreshButton onPress={reload} />
        </View>
      }
      ListEmptyComponent={
        <EmptyState
          text="Nenhuma alteração neste checkout: o working tree está igual ao último commit."
          action="Atualizar"
          onAction={reload}
        />
      }
      renderItem={({ item: section }) => (
        <View>
          <Text style={styles.section}>
            {AREA_TITLE[section.area]} · {section.rows.length}
          </Text>
          {section.rows.map((entry) => (
            <Pressable
              key={`${entry.area}:${entry.path}`}
              style={({ pressed }) => [styles.row, pressed && !entry.restricted && styles.pressed]}
              onPress={() => setOpen(entry)}
              disabled={entry.restricted}
              accessibilityRole="button"
              accessibilityLabel={
                entry.restricted
                  ? `${entry.path}, conteúdo protegido`
                  : `Ver diff de ${entry.path}`
              }
            >
              <Text style={[styles.letter, { color: letterColor(entry) }]}>{entry.letter}</Text>
              <Text style={styles.rowText} numberOfLines={1} ellipsizeMode="middle">
                {entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
              </Text>
              {entry.restricted ? (
                <Lock size={14} color={colors.textMuted} />
              ) : (
                <ChevronRight size={16} color={colors.textMuted} />
              )}
            </Pressable>
          ))}
        </View>
      )}
      ListFooterComponent={
        truncated ? (
          <Text style={styles.note}>Lista cortada pelo desktop: há arquivos demais para mostrar.</Text>
        ) : null
      }
      contentContainerStyle={styles.listContent}
    />
  )
}

function letterColor(entry: NexusGitStatusEntry): string {
  if (entry.conflictStatus === 'unresolved') {
    return colors.statusRed
  }
  if (entry.status === 'added' || entry.status === 'untracked') {
    return colors.gitDecorationAdded
  }
  if (entry.status === 'deleted') {
    return colors.gitDecorationDeleted
  }
  return colors.statusAmber
}

function NexusDiff({
  paneId,
  workspace,
  entry,
  onBack
}: {
  paneId: string
  workspace: NexusWorkspaceApi
  entry: NexusGitStatusEntry
  onBack: () => void
}) {
  const [diff, reload] = useLoad<NexusGitDiff>(`diff:${paneId}:${entry.area}:${entry.path}`, () =>
    workspace.gitDiff(paneId, entry)
  )
  const review = useMemo(() => {
    if (diff.kind !== 'ready') {
      return null
    }
    const { lines, truncated } = nexusDiffLines(diff.value)
    return { ...buildMobileReviewLines(lines, `nexus:${paneId}:${entry.area}:${entry.path}`), truncated }
  }, [diff, entry.area, entry.path, paneId])
  const highlights = useMobileDiffReviewBlockHighlights({
    cacheKey: review?.cacheKey ?? null,
    filePath: review ? entry.path : null,
    rows: review?.rows ?? []
  })

  return (
    <View style={styles.container}>
      <BackBar label={entry.path} onBack={onBack} accessibilityLabel="Voltar para as alterações" />
      {diff.kind !== 'ready' || !review ? (
        <LoadState
          state={diff.kind === 'ready' ? { kind: 'loading' } : diff}
          busyText="Lendo o diff no desktop…"
          onRetry={reload}
        />
      ) : diff.value.kind === 'binary' || (diff.value.kind === 'untracked' && diff.value.binary) ? (
        <EmptyState text="Arquivo binário: o celular não mostra diff de texto para ele." />
      ) : review.rows.length === 0 ? (
        <EmptyState
          text="Sem diferença de texto (só permissão, modo ou arquivo vazio)."
          action="Atualizar"
          onAction={reload}
        />
      ) : (
        <MobileLegendList<MobileReviewLineRow>
          data={review.rows}
          keyExtractor={(row) => row.id}
          estimatedItemSize={20}
          extraData={highlights.highlightVersion}
          onViewableItemsChanged={highlights.onViewableItemsChanged}
          viewabilityConfig={highlights.viewabilityConfig}
          renderItem={({ item, index }) => (
            <MobileDiffReviewLine
              line={item}
              tokens={highlights.tokensForRow(index)}
              comments={NO_COMMENTS}
              staleCommentIds={NO_STALE}
              active={false}
              onAddNote={noop}
              onEditNote={noop}
              readOnly
            />
          )}
          style={styles.code}
          ListFooterComponent={
            review.truncated ? (
              <Text style={styles.note}>Diff cortado: o celular mostra só o começo deste arquivo.</Text>
            ) : null
          }
        />
      )}
    </View>
  )
}

// ---------------------------------------------------------------- Arquivos

function NexusFiles({ paneId, workspace }: { paneId: string; workspace: NexusWorkspaceApi }) {
  const [dir, setDir] = useState('')
  const [file, setFile] = useState<NexusFileEntry | null>(null)
  const [listing, reload] = useLoad<NexusFileList>(`list:${paneId}:${dir}`, () =>
    workspace.listFiles(paneId, dir)
  )

  if (file) {
    return <NexusFile paneId={paneId} workspace={workspace} entry={file} onBack={() => setFile(null)} />
  }
  const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
  return (
    <View style={styles.container}>
      {dir ? (
        <BackBar label={dir} onBack={() => setDir(parent)} accessibilityLabel="Voltar para a pasta de cima" />
      ) : (
        <View style={styles.toolbar}>
          <Text style={styles.toolbarText}>Raiz do checkout</Text>
          <RefreshButton onPress={reload} />
        </View>
      )}
      {listing.kind !== 'ready' ? (
        <LoadState state={listing} busyText="Listando a pasta no desktop…" onRetry={reload} />
      ) : (
        <MobileLegendList
          data={listing.value.entries}
          keyExtractor={(entry) => entry.path}
          estimatedItemSize={48}
          ListEmptyComponent={
            <EmptyState
              text="Pasta vazia, ou só com itens que o desktop não mostra (.git, node_modules, links e arquivos de segredo)."
              action="Atualizar"
              onAction={reload}
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              onPress={() => (item.kind === 'dir' ? setDir(item.path) : setFile(item))}
              accessibilityRole="button"
              accessibilityLabel={item.kind === 'dir' ? `Abrir pasta ${item.name}` : `Ler ${item.name}`}
            >
              {item.kind === 'dir' ? (
                <Folder size={16} color={colors.textSecondary} />
              ) : (
                <FileText size={16} color={colors.textMuted} />
              )}
              <Text style={styles.rowText} numberOfLines={1}>
                {item.name}
              </Text>
              {item.kind === 'dir' ? <ChevronRight size={16} color={colors.textMuted} /> : null}
            </Pressable>
          )}
          ListFooterComponent={
            listing.value.truncated ? (
              <Text style={styles.note}>Pasta grande: o celular mostra só as primeiras 1.000 entradas.</Text>
            ) : null
          }
          contentContainerStyle={styles.listContent}
        />
      )}
    </View>
  )
}

function NexusFile({
  paneId,
  workspace,
  entry,
  onBack
}: {
  paneId: string
  workspace: NexusWorkspaceApi
  entry: NexusFileEntry
  onBack: () => void
}) {
  const [read, reload] = useLoad<NexusFileRead>(`read:${paneId}:${entry.path}`, () =>
    workspace.readFile(paneId, entry.path)
  )
  const lines = useMemo(
    () =>
      read.kind === 'ready' && !read.value.binary
        ? read.value.content.replace(/\n$/, '').split(/\r?\n/)
        : [],
    [read]
  )
  return (
    <View style={styles.container}>
      <BackBar label={entry.path} onBack={onBack} accessibilityLabel="Voltar para a pasta" />
      {read.kind !== 'ready' ? (
        <LoadState state={read} busyText="Lendo o arquivo no desktop…" onRetry={reload} />
      ) : read.value.binary ? (
        <EmptyState text={`Arquivo binário (${formatBytes(read.value.byteLength)}): não é mostrado no celular.`} />
      ) : read.value.byteLength === 0 ? (
        <EmptyState text="Arquivo vazio." />
      ) : (
        <MobileLegendList
          data={lines}
          keyExtractor={(_line, index) => String(index)}
          estimatedItemSize={18}
          renderItem={({ item, index }) => (
            <View style={styles.fileLine}>
              <Text style={styles.fileLineNumber}>{index + 1}</Text>
              <Text style={styles.fileLineText} selectable>
                {item}
              </Text>
            </View>
          )}
          style={styles.code}
          ListFooterComponent={
            read.value.truncated ? (
              <Text style={styles.note}>
                Arquivo cortado: o celular mostra só o começo ({formatBytes(read.value.byteLength)} no
                total).
              </Text>
            ) : null
          }
        />
      )}
    </View>
  )
}

// ---------------------------------------------------------------- peças

function BackBar({
  label,
  onBack,
  accessibilityLabel
}: {
  label: string
  onBack: () => void
  accessibilityLabel: string
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.backBar, pressed && styles.pressed]}
      onPress={onBack}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <ChevronLeft size={18} color={colors.textSecondary} />
      <Text style={styles.backText} numberOfLines={1} ellipsizeMode="head">
        {label}
      </Text>
    </Pressable>
  )
}

function RefreshButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.refresh, pressed && styles.pressed]}
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Atualizar"
    >
      <RefreshCw size={14} color={colors.textSecondary} />
    </Pressable>
  )
}

function LoadState<T>({
  state,
  busyText,
  onRetry
}: {
  state: Exclude<Load<T>, { kind: 'ready' }>
  busyText: string
  onRetry: () => void
}) {
  if (state.kind === 'loading') {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={styles.stateText}>{busyText}</Text>
      </View>
    )
  }
  return (
    <EmptyState text={state.message} action="Tentar de novo" onAction={onRetry} tone="error" />
  )
}

function EmptyState({
  text,
  action,
  onAction,
  tone
}: {
  text: string
  action?: string
  onAction?: () => void
  tone?: 'error'
}) {
  return (
    <View style={styles.state} accessibilityLiveRegion="polite">
      <Text style={[styles.stateText, tone === 'error' && styles.errorText]}>{text}</Text>
      {action && onAction ? (
        <Pressable
          style={({ pressed }) => [styles.stateButton, pressed && styles.pressed]}
          onPress={onAction}
          accessibilityRole="button"
        >
          <Text style={styles.stateButtonText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: spacing.sm },
  openers: { flexDirection: 'row', gap: spacing.sm },
  opener: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  openerText: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  pressed: { backgroundColor: colors.bgRaised },
  disabled: { opacity: 0.4 },
  segment: {
    flexDirection: 'row',
    padding: 2,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel
  },
  segmentItem: { flex: 1, minHeight: 36, justifyContent: 'center', alignItems: 'center', borderRadius: radii.button },
  segmentItemActive: { backgroundColor: colors.bgRaised },
  segmentText: { color: colors.textSecondary, fontSize: typography.bodySize },
  segmentTextActive: { color: colors.textPrimary, fontWeight: '600' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 36
  },
  toolbarText: { flex: 1, color: colors.textSecondary, fontSize: typography.metaSize },
  refresh: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.button
  },
  listContent: { paddingBottom: spacing.lg },
  section: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginTop: spacing.md,
    marginBottom: spacing.xs
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radii.row,
    backgroundColor: colors.bgPanel,
    marginBottom: spacing.xs
  },
  letter: { width: 14, fontFamily: typography.monoFamily, fontSize: typography.metaSize, fontWeight: '700' },
  rowText: { flex: 1, color: colors.textPrimary, fontSize: typography.bodySize },
  backBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 40,
    borderRadius: radii.row
  },
  backText: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  code: { flex: 1, borderRadius: radii.card, backgroundColor: colors.editorSurface },
  fileLine: { flexDirection: 'row', paddingHorizontal: spacing.sm },
  fileLineNumber: {
    width: 40,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 18,
    textAlign: 'right',
    marginRight: spacing.sm
  },
  fileLineText: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  state: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl, paddingHorizontal: spacing.lg },
  stateText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    textAlign: 'center'
  },
  errorText: { color: colors.statusRed },
  stateButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  stateButtonText: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  note: { color: colors.textMuted, fontSize: typography.metaSize, lineHeight: 17, marginTop: spacing.sm }
})
