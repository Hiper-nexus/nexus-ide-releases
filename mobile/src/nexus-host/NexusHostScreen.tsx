// Tela de um host "nexus-bridge" (F-994): o mesmo escopo do PWA Nexus Remote —
// aprovações, missões, panes, saída ao vivo e envio de um comando completo. Git e
// arquivos do pane, só leitura (F-1014), ficam em NexusPaneWorkspace.tsx; as demais
// telas do Orca (worktrees, abas…) não têm equivalente na bridge.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { encodeApprovalPrompt } from '../../../src/shared/approval-decision'
import { useHostClient } from '../transport/client-context'
import { loadHostCatalog } from '../transport/host-store'
import {
  nexusHostApiOf,
  type NexusApproval,
  type NexusOpsSnapshot,
  type NexusPane
} from '../transport/nexus-bridge-rpc-adapter'
import { NEXUS_BRIDGE_HOST_KIND, type ConnectionState } from '../transport/types'
import { decodeApprovalResponseToken } from '../session/mobile-structured-agent-prompts'
import { parseApprovalFromStatus } from '../session/mobile-native-chat-permission'
import { sendMobileHookApprovalResponse } from '../session/mobile-native-chat-permission-send'
import { MobileNativeChatPermission } from '../session/MobileNativeChatPermission'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
// F-1015: ditado, notificações e fila offline do host Nexus.
import { NexusCommandInput } from './NexusCommandInput'
import {
  useNexusApprovalNotifications,
  useNexusHostNotificationFocus
} from './nexus-host-notifications'
import { useNexusHostOutboxFlush } from './use-nexus-host-outbox'
// F-1014 (início)
import {
  NexusPaneWorkspace,
  NexusWorkspaceOpeners,
  type NexusWorkspaceView
} from './NexusPaneWorkspace'
// F-1014 (fim)

const SNAPSHOT_POLL_MS = 15_000
const OUTPUT_MAX_CHARS = 200_000
const OUTPUT_KEEP_CHARS = 160_000

export const NEXUS_HOST_UNSUPPORTED_NOTE =
  'Não disponível em host Nexus: teclas cruas (Ctrl-C, Esc, "1"), stage/commit e edição de ' +
  'arquivos (Git e arquivos são só leitura), worktrees, abas de sessão, contas, voz pelo app ' +
  '(use o ditado do teclado), screencast e Linear/GitHub/GitLab. Use o desktop para isso.'

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: 'conectando…',
  handshaking: 'autenticando…',
  connected: 'conectado',
  disconnected: 'desconectado',
  reconnecting: 'reconectando…',
  'auth-failed': 'sessão encerrada'
}

/** 'loading' enquanto o catálogo carrega; depois diz se o host é do desktop Nexus. */
export function useIsNexusBridgeHost(hostId: string | undefined): boolean | 'loading' {
  const [kind, setKind] = useState<{ hostId: string | undefined; nexus: boolean } | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadHostCatalog()
      .then((catalog) => catalog.find((entry) => entry.id === hostId)?.kind)
      .catch(() => undefined)
      .then((found) => {
        if (!cancelled) {
          setKind({ hostId, nexus: found === NEXUS_BRIDGE_HOST_KIND })
        }
      })
    return () => {
      cancelled = true
    }
  }, [hostId])
  return kind && kind.hostId === hostId ? kind.nexus : 'loading'
}

export function NexusHostScreen({ hostId }: { hostId: string }) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { client, state } = useHostClient(hostId)
  const nexus = nexusHostApiOf(client)
  const [hostName, setHostName] = useState('Nexus')
  const [snapshot, setSnapshot] = useState<NexusOpsSnapshot | null>(null)
  const [error, setError] = useState('')
  const [pane, setPane] = useState<NexusPane | null>(null)
  // F-1014: "Alterações"/"Arquivos" do pane aberto (null = terminal).
  const [workspaceView, setWorkspaceView] = useState<{
    paneId: string
    view: NexusWorkspaceView
  } | null>(null)
  const openWorkspace = pane && workspaceView?.paneId === pane.paneId ? workspaceView.view : null

  useEffect(() => {
    void loadHostCatalog()
      .then((catalog) => {
        const name = catalog.find((entry) => entry.id === hostId)?.name
        if (name) {
          setHostName(name)
        }
      })
      .catch(() => undefined)
  }, [hostId])

  const refresh = useCallback(async () => {
    if (!nexus) {
      return
    }
    try {
      setSnapshot(await nexus.snapshot())
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [nexus])

  useEffect(() => {
    if (!nexus || state !== 'connected') {
      return
    }
    void refresh()
    const poll = setInterval(() => void refresh(), SNAPSHOT_POLL_MS)
    // O push só avisa; o snapshot reaplica a autoridade do desktop (só panes que este aparelho lê).
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = nexus.onApprovalsChanged(() => {
      if (debounce) {
        clearTimeout(debounce)
      }
      debounce = setTimeout(() => void refresh(), 300)
    })
    return () => {
      clearInterval(poll)
      if (debounce) {
        clearTimeout(debounce)
      }
      unsubscribe()
    }
  }, [nexus, refresh, state])

  // ─── F-1015 ───
  useNexusApprovalNotifications({
    hostId,
    hostName,
    nexus,
    snapshot,
    approvalsOnScreen: pane === null
  })
  const highlightedApproval = useNexusHostNotificationFocus({
    hostId,
    snapshot,
    showApprovals: () => setPane(null),
    openPane: setPane
  })
  const queuedPanes = useNexusHostOutboxFlush({
    hostId,
    nexus,
    state,
    activePaneId: pane?.paneId ?? null
  })
  // ─── fim F-1015 ───

  const respondApproval = useCallback(
    async (send: string): Promise<boolean> => {
      const target = decodeApprovalResponseToken(send)
      if (!client || !target) {
        setError('Resposta não enviada (desconectado)')
        return false
      }
      const outcome = await sendMobileHookApprovalResponse({ client, target })
      if (outcome !== 'accepted') {
        setError(
          outcome === 'unknown'
            ? 'Resposta sem confirmação — confira o desktop antes de repetir'
            : 'Resposta recusada pelo desktop (pedido fechado ou sem permissão neste pane)'
        )
      }
      void refresh()
      return outcome === 'accepted'
    },
    [client, refresh]
  )

  const back = () => {
    if (openWorkspace) {
      setWorkspaceView(null) // F-1014: volta ao terminal do pane
      return
    }
    if (pane) {
      setPane(null)
      return
    }
    if (router.canGoBack()) {
      router.back()
    } else {
      router.replace('/')
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Pressable
          onPress={back}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            openWorkspace ? 'Voltar para o terminal' : pane ? 'Voltar para a lista' : 'Voltar'
          }
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {pane ? pane.title : hostName}
          </Text>
          <Text style={styles.subtitle}>Desktop Nexus · {STATE_LABEL[state]}</Text>
        </View>
        <View
          style={[styles.dot, state === 'connected' ? styles.dotOn : styles.dotOff]}
          accessibilityLabel={STATE_LABEL[state]}
        />
      </View>

      {state === 'auth-failed' ? (
        <View style={styles.card}>
          <Text style={styles.body}>
            O desktop recusou a credencial deste aparelho (revogada ou expirada). Gere um código
            novo no desktop e pareie de novo.
          </Text>
          <Pressable style={styles.primaryButton} onPress={() => router.push('/pair-scan')}>
            <Text style={styles.primaryButtonText}>Parear de novo</Text>
          </Pressable>
        </View>
      ) : state !== 'connected' ? (
        <View style={styles.card}>
          <Text style={styles.body}>
            {STATE_LABEL[state]} — o app só conecta por HTTPS válido (Tailscale Serve). Se não
            passar daqui, confira se o celular está no tailnet e se a bridge está ligada no desktop.
          </Text>
          {queuedPanes > 0 ? (
            <Text style={styles.muted}>
              Comandos na fila em {queuedPanes} {queuedPanes === 1 ? 'pane' : 'panes'}: saem em
              ordem quando reconectar.
            </Text>
          ) : null}
          <Pressable style={styles.secondaryButton} onPress={() => client?.notifyForeground()}>
            <Text style={styles.secondaryButtonText}>Tentar agora</Text>
          </Pressable>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {pane && nexus && openWorkspace ? (
        // F-1014 (início)
        <View style={styles.detail}>
          <NexusPaneWorkspace
            paneId={pane.paneId}
            workspace={nexus.workspace}
            view={openWorkspace}
            onViewChange={(view) => setWorkspaceView({ paneId: pane.paneId, view })}
          />
        </View>
      ) : // F-1014 (fim)
      pane && nexus ? (
        <NexusPaneDetail
          key={pane.paneId}
          hostId={hostId}
          pane={pane}
          nexus={nexus}
          client={client}
          state={state}
          onOpenWorkspace={(view) => setWorkspaceView({ paneId: pane.paneId, view })}
          onClosed={() => {
            setPane(null)
            void refresh()
          }}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <NexusApprovals
            approvals={snapshot?.approvals ?? []}
            panes={snapshot?.panes ?? []}
            highlightedRequestId={highlightedApproval}
            onRespond={respondApproval}
          />
          <Text style={styles.section}>Missões</Text>
          {snapshot === null && state === 'connected' ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : (snapshot?.missions.length ?? 0) === 0 ? (
            <Text style={styles.muted}>nenhuma missão</Text>
          ) : (
            snapshot?.missions.slice(0, 40).map((mission) => (
              <View key={mission.id} style={styles.row}>
                <Text style={styles.rowText} numberOfLines={1}>
                  {mission.title}
                </Text>
                <Text style={styles.muted}>{mission.status}</Text>
              </View>
            ))
          )}
          <Text style={styles.section}>Panes</Text>
          {(snapshot?.panes ?? []).map((item) => (
            <Pressable
              key={item.paneId}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => setPane(item)}
              accessibilityRole="button"
              accessibilityLabel={`Abrir pane ${item.title}`}
            >
              <View style={[styles.dot, item.state === 'busy' ? styles.dotBusy : styles.dotOn]} />
              <Text style={styles.rowText} numberOfLines={1}>
                {item.paneNumber ? `${item.paneNumber} · ` : ''}
                {item.title}
              </Text>
              <Text style={styles.muted}>{item.state}</Text>
            </Pressable>
          ))}
          {snapshot && snapshot.panes.length === 0 ? (
            <Text style={styles.muted}>nenhum pane visível para este aparelho</Text>
          ) : null}
          <Text style={styles.note}>{NEXUS_HOST_UNSUPPORTED_NOTE}</Text>
        </ScrollView>
      )}
    </View>
  )
}

function NexusApprovals({
  approvals,
  panes,
  highlightedRequestId,
  onRespond
}: {
  approvals: readonly NexusApproval[]
  panes: readonly NexusPane[]
  highlightedRequestId: string | null
  onRespond: (send: string) => Promise<boolean>
}) {
  const live = approvals.filter((approval) => approval.responseCapability === 'live')
  if (live.length === 0) {
    return null
  }
  return (
    <View accessibilityLiveRegion="polite">
      <Text style={styles.section}>Aprovação pendente</Text>
      {live.slice(0, 10).map((approval) => {
        // O mesmo card estruturado do chat nativo: decisão para o broker, nunca tecla no PTY.
        const permission = parseApprovalFromStatus(encodeApprovalPrompt(approval))
        if (!permission) {
          return null
        }
        const paneTitle = panes.find((item) => item.paneId === approval.paneId)?.title
        return (
          <View
            key={`${approval.requestId}:${approval.revision}`}
            style={[
              styles.approvalItem,
              approval.requestId === highlightedRequestId && styles.approvalFocused
            ]}
          >
            <Text style={styles.approvalPane}>pane {paneTitle ?? approval.paneId}</Text>
            <MobileNativeChatPermission permission={permission} onRespond={onRespond} />
          </View>
        )
      })}
    </View>
  )
}

function NexusPaneDetail({
  hostId,
  pane,
  nexus,
  client,
  state,
  onOpenWorkspace,
  onClosed
}: {
  hostId: string
  pane: NexusPane
  nexus: NonNullable<ReturnType<typeof nexusHostApiOf>>
  client: ReturnType<typeof useHostClient>['client']
  state: ConnectionState
  onOpenWorkspace: (view: NexusWorkspaceView) => void
  onClosed: () => void
}) {
  const connected = state === 'connected'
  const [output, setOutput] = useState('')
  const [detailError, setDetailError] = useState('')
  const scrollRef = useRef<ScrollView | null>(null)

  useEffect(
    () =>
      nexus.subscribePane(pane.paneId, (chunk) => {
        setOutput((previous) => {
          const next = chunk.reset ? chunk.text : previous + chunk.text
          return next.length > OUTPUT_MAX_CHARS ? next.slice(next.length - OUTPUT_KEEP_CHARS) : next
        })
      }),
    [nexus, pane.paneId]
  )

  const confirmClose = () => {
    Alert.alert('Fechar pane?', `${pane.title} será fechado no desktop.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Fechar',
        style: 'destructive',
        onPress: () => {
          nexus.closePane(pane.paneId).then(onClosed, (err: unknown) =>
            setDetailError(err instanceof Error ? err.message : String(err))
          )
        }
      }
    ])
  }

  return (
    <View style={styles.detail}>
      {/* F-1014: Git e arquivos do checkout deste pane, só leitura. */}
      <NexusWorkspaceOpeners onOpen={onOpenWorkspace} disabled={!connected} />
      <ScrollView
        ref={scrollRef}
        style={styles.output}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        <Text style={styles.outputText} selectable>
          {output || '…'}
        </Text>
      </ScrollView>
      {detailError ? <Text style={styles.error}>{detailError}</Text> : null}
      <NexusCommandInput
        hostId={hostId}
        pane={pane}
        nexus={nexus}
        client={client}
        state={state}
      />
      <Text style={styles.note}>
        Comandos fora da lista de rotina (git status, npm test…) pedem confirmação no desktop.{' '}
        {NEXUS_HOST_UNSUPPORTED_NOTE}
      </Text>
      <Pressable style={styles.secondaryButton} onPress={confirmClose} disabled={!connected}>
        <Text style={styles.dangerText}>Fechar pane</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '600' },
  subtitle: { color: colors.textSecondary, fontSize: typography.metaSize },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: colors.statusGreen },
  dotOff: { backgroundColor: colors.textMuted },
  dotBusy: { backgroundColor: colors.statusAmber },
  card: {
    margin: spacing.lg,
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  body: { color: colors.textPrimary, fontSize: typography.bodySize, lineHeight: 20 },
  error: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm
  },
  scroll: { padding: spacing.lg, gap: spacing.xs },
  section: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginTop: spacing.lg,
    marginBottom: spacing.xs
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.row,
    backgroundColor: colors.bgPanel,
    minHeight: 44
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowText: { flex: 1, color: colors.textPrimary, fontSize: typography.bodySize },
  muted: { color: colors.textMuted, fontSize: typography.metaSize },
  note: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: 17,
    marginTop: spacing.lg
  },
  approvalPane: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm
  },
  detail: { flex: 1, padding: spacing.lg, gap: spacing.sm },
  output: {
    flex: 1,
    borderRadius: radii.card,
    backgroundColor: colors.terminalBg,
    padding: spacing.md
  },
  outputText: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 17
  },
  // F-1035: o card compartilhado do chat já tem margem lateral própria; sem compensar o
  // padding da lista, ele ficava recuado em relação às linhas de missões e panes.
  approvalItem: { marginHorizontal: -spacing.lg },
  approvalFocused: {
    borderLeftWidth: 2,
    borderLeftColor: colors.accentBlue
  },
  primaryButton: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg
  },
  primaryButtonText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '600' },
  buttonDisabled: { opacity: 0.4 },
  secondaryButton: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  secondaryButtonText: { color: colors.textPrimary, fontSize: typography.bodySize },
  dangerText: { color: colors.statusRed, fontSize: typography.bodySize, fontWeight: '600' }
})
