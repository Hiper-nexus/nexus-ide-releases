// MOB-05 (F-1021): o cartão "Atividade" no detalhe do pane e o selo na lista de
// panes do host Nexus. Ponto de status + palavra (nunca só cor) e o texto que diz
// o que fazer; o estado vem do desktop (nexus-pane-activity.ts).
import { StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  nexusActivitySince,
  nexusPaneActivityLabel,
  type NexusPaneActivityTone,
  type NexusPaneActivityView
} from './nexus-pane-activity'

const TONE_COLOR: Record<NexusPaneActivityTone, string> = {
  working: colors.statusAmber,
  waiting: colors.accentBlue,
  done: colors.statusGreen,
  off: colors.textMuted
}

export function NexusPaneActivityCard({
  view,
  now = Date.now()
}: {
  view: NexusPaneActivityView | null
  now?: number
}) {
  if (!view) {
    return null
  }
  const { label, detail, tone } = nexusPaneActivityLabel(view)
  const since = nexusActivitySince(view.at, now)
  return (
    <View
      style={[styles.card, { borderLeftColor: TONE_COLOR[tone] }]}
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Atividade: ${label}${since ? `, ${since}` : ''}. ${detail}`}
    >
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: TONE_COLOR[tone] }]} />
        <Text style={styles.label}>{label}</Text>
        {since ? <Text style={styles.since}>{since}</Text> : null}
      </View>
      <Text style={styles.detail}>{detail}</Text>
    </View>
  )
}

/** Selo da linha do pane; sem leitura de atividade, mostra o estado cru. */
export function NexusPaneActivityBadge({
  view,
  fallback
}: {
  view: NexusPaneActivityView | null
  fallback: string
}) {
  if (!view) {
    return <Text style={styles.since}>{fallback}</Text>
  }
  const { label, tone } = nexusPaneActivityLabel(view)
  return (
    <View style={styles.badge}>
      <View style={[styles.dot, { backgroundColor: TONE_COLOR[tone] }]} />
      <Text style={[styles.badgeText, tone === 'waiting' && styles.badgeTextStrong]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.card,
    borderLeftWidth: 2,
    backgroundColor: colors.bgPanel
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { flex: 1, color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  since: { color: colors.textMuted, fontSize: typography.metaSize },
  detail: { color: colors.textSecondary, fontSize: typography.metaSize, lineHeight: 17 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  badgeText: { color: colors.textMuted, fontSize: typography.metaSize },
  badgeTextStrong: { color: colors.textPrimary, fontWeight: '600' }
})
