// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: só o ComposerQueuedEditBanner de ComposerQueuedEdit.tsx, em StyleSheet com o tema mobile (sem uniwind/SymbolView); os chips de anexo ficam de fora porque o outbox do Nexus não guarda anexos.
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

/**
 * The composer is shared, so editing a queued message needs a visible way back
 * out. This is that way out, and the only place the edit announces itself.
 */
export function MobileNativeChatQueuedEditBanner(props: {
  readonly onCancel: () => void
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.label} numberOfLines={1}>
        Editing queued message
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel editing queued message"
        onPress={props.onCancel}
        hitSlop={8}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      >
        <Text style={styles.actionLabel}>Cancel</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs
  },
  label: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  action: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs
  },
  actionLabel: {
    color: colors.accentBlue,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  pressed: {
    opacity: 0.6
  }
})
