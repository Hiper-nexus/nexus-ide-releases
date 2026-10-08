// Campo de comando do pane no host Nexus (F-1015): fila offline (pendente,
// enviando, retido, falhou, enviado), microfone (ouvindo, transcrevendo, negado,
// indisponível) e a mesma recusa de tecla crua do adaptador (F-1000). Estado
// nunca só por cor: cada item leva ícone + palavra.
import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { AlertTriangle, Check, Clock, Mic, MicOff, Square, X } from 'lucide-react-native'
import type { NexusHostApi, NexusPane } from '../transport/nexus-bridge-rpc-adapter'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  NEXUS_DICTATION_UNAVAILABLE_HINT,
  useNexusCommandDictation,
  type NexusMicState
} from './nexus-command-dictation'
import { useNexusPaneOutbox, type NexusQueuedCommand } from './use-nexus-host-outbox'

const MIC_LABEL: Record<NexusMicState, string> = {
  unavailable: 'Ditado indisponível neste desktop — abrir o teclado',
  idle: 'Ditar comando',
  starting: 'Preparando o microfone',
  listening: 'Ouvindo — toque para parar e transcrever',
  processing: 'Transcrevendo',
  denied: 'Microfone negado',
  error: 'Ditar de novo'
}

const STATUS_LABEL: Record<NexusQueuedCommand['status'], string> = {
  pending: 'na fila — sai quando reconectar',
  sending: 'enviando…',
  held: 'retido',
  stale: 'antigo — confirmar',
  waiting: 'espera o anterior'
}

export function NexusCommandInput({
  hostId,
  pane,
  nexus,
  client,
  state,
  dictationAvailable
}: {
  hostId: string
  pane: NexusPane
  nexus: NexusHostApi
  client: RpcClient | null
  state: ConnectionState
  dictationAvailable?: boolean
}) {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<TextInput | null>(null)
  const connected = state === 'connected'
  const revoked = state === 'auth-failed'
  const outbox = useNexusPaneOutbox({ hostId, paneId: pane.paneId, nexus, state })

  const openKeyboard = useCallback(() => {
    setHint(NEXUS_DICTATION_UNAVAILABLE_HINT)
    inputRef.current?.focus()
  }, [])
  const dictation = useNexusCommandDictation({
    client,
    connected,
    available: dictationAvailable,
    setInput,
    onUnavailable: openKeyboard
  })

  // O ditado só preenche o campo; enviar é sempre um toque do operador.
  const submit = async () => {
    if (submitting || !input.trim()) {
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const refusal = await outbox.submit(input)
      if (refusal) {
        setError(refusal)
      } else {
        setInput('')
        setHint('')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const micBusy = dictation.micState === 'starting' || dictation.micState === 'processing'
  const MicIcon =
    dictation.micState === 'listening'
      ? Square
      : dictation.micState === 'unavailable' || dictation.micState === 'denied'
        ? MicOff
        : Mic

  return (
    <View style={styles.wrap}>
      {outbox.hold ? (
        <View style={styles.holdCard} accessibilityLiveRegion="polite">
          <View style={styles.statusRow}>
            <AlertTriangle size={14} color={colors.statusAmber} />
            <Text style={styles.holdTitle}>
              {outbox.hold.reason === 'revoked'
                ? 'Fila retida: o desktop revogou este aparelho'
                : 'Fila parada: o desktop recusou um comando'}
            </Text>
          </View>
          {outbox.hold.reason === 'rejected' && outbox.hold.text ? (
            <Text style={styles.failedText} numberOfLines={2}>
              falhou: {outbox.hold.text} — {outbox.hold.detail}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            {outbox.hold.reason === 'revoked'
              ? 'Nada da fila sai sozinho. Pareie de novo e toque em Retomar, ou descarte.'
              : 'Os comandos seguintes deste pane esperam você decidir.'}
          </Text>
          <View style={styles.actionsRow}>
            <Pressable
              style={styles.smallButton}
              onPress={() => void outbox.resume()}
              accessibilityRole="button"
            >
              <Text style={styles.smallButtonText}>Retomar</Text>
            </Pressable>
            <Pressable
              style={styles.smallButton}
              onPress={() => void outbox.discardAll()}
              accessibilityRole="button"
            >
              <Text style={styles.dangerText}>Descartar fila</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {outbox.queued.some((item) => item.status === 'stale') ? (
        <Text style={styles.meta} accessibilityLiveRegion="polite">
          Comando parado há mais de 8 min não sai sozinho: confira e toque em Enviar ou
          Descartar. Os seguintes deste pane esperam por ele.
        </Text>
      ) : null}
      {outbox.queued.map((item) => (
        <View key={item.messageId} style={styles.queueRow} accessibilityLabel={`Comando ${STATUS_LABEL[item.status]}: ${item.text}`}>
          {item.status === 'sending' ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : item.status === 'held' || item.status === 'stale' ? (
            <AlertTriangle size={14} color={colors.statusAmber} />
          ) : (
            <Clock size={14} color={colors.textSecondary} />
          )}
          <Text style={styles.queueText} numberOfLines={1}>
            {item.text}
          </Text>
          <Text style={styles.meta}>
            {item.status === 'sending' && item.attempts > 1 ? 'tentando de novo…' : STATUS_LABEL[item.status]}
          </Text>
          {item.status === 'stale' ? (
            <Pressable
              style={styles.smallButton}
              onPress={() => outbox.sendNow(item.messageId)}
              accessibilityRole="button"
              accessibilityLabel={`Enviar comando antigo: ${item.text}`}
            >
              <Text style={styles.smallButtonText}>Enviar</Text>
            </Pressable>
          ) : null}
          {item.status === 'stale' ? (
            <Pressable
              style={styles.smallButton}
              onPress={() => void outbox.cancel(item.messageId)}
              accessibilityRole="button"
              accessibilityLabel={`Descartar comando antigo: ${item.text}`}
            >
              <Text style={styles.dangerText}>Descartar</Text>
            </Pressable>
          ) : item.status !== 'sending' ? (
            <Pressable
              onPress={() => void outbox.cancel(item.messageId)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Tirar da fila: ${item.text}`}
            >
              <X size={16} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
      ))}

      {outbox.lastSent && outbox.queued.length === 0 ? (
        <View style={styles.queueRow} accessibilityLiveRegion="polite">
          <Check size={14} color={colors.statusGreen} />
          <Text style={styles.queueText} numberOfLines={1}>
            {outbox.lastSent.text}
          </Text>
          <Text style={styles.meta}>enviado</Text>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {dictation.errorText ? <Text style={styles.error}>{dictation.errorText}</Text> : null}
      {hint && dictation.micState === 'unavailable' ? <Text style={styles.meta}>{hint}</Text> : null}
      {dictation.micState === 'listening' ? (
        <Text style={styles.listening} accessibilityLiveRegion="polite">
          ouvindo… toque no quadrado para parar; o texto entra no campo para você revisar
        </Text>
      ) : null}

      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={
            connected ? 'comando completo (Enter é enviado junto)' : 'sem conexão: o comando vai para a fila'
          }
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          onSubmitEditing={() => void submit()}
          editable={!revoked}
          accessibilityLabel="Comando para o pane"
        />
        <Pressable
          style={[
            styles.micButton,
            dictation.micState === 'listening' && styles.micListening,
            (revoked || micBusy) && styles.buttonDisabled
          ]}
          onPress={() => void dictation.toggle()}
          disabled={revoked || micBusy}
          accessibilityRole="button"
          accessibilityLabel={MIC_LABEL[dictation.micState]}
          accessibilityState={{ busy: micBusy, disabled: revoked || micBusy }}
        >
          {micBusy ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <MicIcon
              size={18}
              color={
                dictation.micState === 'listening'
                  ? colors.statusRed
                  : dictation.micState === 'unavailable' || dictation.micState === 'denied'
                    ? colors.textMuted
                    : colors.textPrimary
              }
            />
          )}
        </Pressable>
        <Pressable
          style={[styles.primaryButton, (revoked || submitting || !input.trim()) && styles.buttonDisabled]}
          onPress={() => void submit()}
          disabled={revoked || submitting || !input.trim()}
          accessibilityRole="button"
          accessibilityLabel={connected ? 'Enviar comando' : 'Pôr comando na fila'}
        >
          <Text style={styles.primaryButtonText}>{connected ? 'Enviar' : 'Na fila'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  holdCard: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusAmber,
    backgroundColor: colors.bgPanel
  },
  holdTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600', flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actionsRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  smallButton: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  smallButtonText: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '600' },
  dangerText: { color: colors.statusRed, fontSize: typography.metaSize, fontWeight: '600' },
  failedText: { color: colors.statusRed, fontSize: typography.metaSize, fontFamily: typography.monoFamily },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radii.row,
    backgroundColor: colors.bgPanel
  },
  queueText: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  meta: { color: colors.textMuted, fontSize: typography.metaSize },
  listening: { color: colors.textSecondary, fontSize: typography.metaSize },
  error: { color: colors.statusRed, fontSize: typography.metaSize },
  inputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    paddingHorizontal: spacing.md
  },
  micButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  micListening: { borderColor: colors.statusRed },
  primaryButton: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg
  },
  primaryButtonText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '600' },
  buttonDisabled: { opacity: 0.4 }
})
