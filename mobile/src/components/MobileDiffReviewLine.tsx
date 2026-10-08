import { Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native'
import { MessageSquare } from 'lucide-react-native'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { MobileDiffLine } from '../session/mobile-diff-lines'
import { mobileDiffLineNumber, mobileDiffLinePrefix } from '../source-control/mobile-diff-format'
import type { MobileReviewToken } from '../source-control/mobile-review-model'
import { colors, spacing, typography } from '../theme/mobile-theme'

type Props = {
  line: MobileDiffLine
  /** Syntax + word-diff tokens for this row; null until its block is highlighted. */
  tokens?: ReadonlyArray<MobileReviewToken> | null
  comments: readonly DiffComment[]
  staleCommentIds: ReadonlySet<string>
  active: boolean
  onAddNote: (lineNumber: number) => void
  onEditNote: (comment: DiffComment) => void
  /** Só leitura (host Nexus, F-1014): a linha não vira botão de nota. */
  readOnly?: boolean
}

function accessibilityLabelForLine(line: MobileDiffLine): string {
  const number = mobileDiffLineNumber(line)
  const label = line.kind === 'add' ? 'Added' : line.kind === 'delete' ? 'Deleted' : 'Context'
  return number ? `${label} line ${number}` : `${label} line`
}

function canCommentOnLine(line: MobileDiffLine): boolean {
  return line.kind !== 'delete' && line.newLineNumber !== undefined
}

// Shiki FontStyle bit flags.
const FONT_STYLE_ITALIC = 1
const FONT_STYLE_BOLD = 2
const FONT_STYLE_UNDERLINE = 4
const tokenStyleCache = new Map<string, TextStyle>()

function tokenStyle(token: MobileReviewToken): TextStyle {
  const fontStyle = token.fontStyle ?? 0
  const key = `${token.color ?? ''}:${fontStyle}`
  let style = tokenStyleCache.get(key)
  if (!style) {
    style = {
      color: token.color ?? colors.textPrimary,
      ...(fontStyle & FONT_STYLE_ITALIC ? { fontStyle: 'italic' as const } : {}),
      ...(fontStyle & FONT_STYLE_BOLD ? { fontWeight: '700' as const } : {}),
      ...(fontStyle & FONT_STYLE_UNDERLINE ? { textDecorationLine: 'underline' as const } : {})
    }
    tokenStyleCache.set(key, style)
  }
  return style
}

function MobileReviewTokens({
  tokens,
  kind
}: {
  tokens: ReadonlyArray<MobileReviewToken>
  kind: MobileDiffLine['kind']
}) {
  const wordStyle =
    kind === 'add' ? styles.addedWord : kind === 'delete' ? styles.deletedWord : null
  return (
    <>
      {tokens.map((token, index) => {
        const style = tokenStyle(token)
        return (
          <Text key={index} style={token.diffHighlight && wordStyle ? [style, wordStyle] : style}>
            {token.content}
          </Text>
        )
      })}
    </>
  )
}

export function MobileDiffReviewLine({
  line,
  tokens,
  comments,
  staleCommentIds,
  active,
  onAddNote,
  onEditNote,
  readOnly = false
}: Props) {
  const lineNumber = mobileDiffLineNumber(line)
  const canComment = !readOnly && canCommentOnLine(line)

  return (
    <View
      style={[
        styles.row,
        line.kind === 'add' && styles.addedRow,
        line.kind === 'delete' && styles.deletedRow,
        active && styles.activeRow
      ]}
      accessible
      accessibilityLabel={accessibilityLabelForLine(line)}
    >
      <Text style={styles.prefix}>{mobileDiffLinePrefix(line.kind)}</Text>
      <Text style={styles.lineNumber}>{lineNumber ? String(lineNumber) : ''}</Text>
      <Pressable
        style={({ pressed }) => [styles.code, pressed && canComment && styles.codePressed]}
        disabled={!canComment}
        onPress={() => {
          if (canComment && line.newLineNumber !== undefined) {
            onAddNote(line.newLineNumber)
          }
        }}
        accessibilityRole={canComment ? 'button' : 'text'}
        accessibilityLabel={
          canComment && line.newLineNumber !== undefined
            ? `Add note on line ${line.newLineNumber}`
            : accessibilityLabelForLine(line)
        }
      >
        <Text style={styles.codeText}>
          {tokens && tokens.length > 0 ? (
            <MobileReviewTokens tokens={tokens} kind={line.kind} />
          ) : (
            line.text
          )}
        </Text>
      </Pressable>
      {comments.length > 0 ? (
        <View style={styles.notes}>
          {comments.map((comment) => (
            <Pressable
              key={comment.id}
              style={({ pressed }) => [styles.noteButton, pressed && styles.noteButtonPressed]}
              onPress={() => onEditNote(comment)}
              accessibilityRole="button"
              accessibilityLabel={`Edit note on line ${comment.lineNumber}`}
            >
              <MessageSquare
                size={13}
                color={staleCommentIds.has(comment.id) ? colors.statusAmber : colors.textSecondary}
                strokeWidth={2}
              />
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
}

// Row height comes from the 18px code lineHeight alone (no vertical padding or
// minHeight) so mobile diff density matches the desktop diff editor (STA-1239).
const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  addedRow: {
    backgroundColor: colors.diffAddedBg
  },
  deletedRow: {
    backgroundColor: colors.diffDeletedBg
  },
  activeRow: {
    borderLeftWidth: 2,
    borderLeftColor: colors.accentBlue
  },
  prefix: {
    width: 18,
    textAlign: 'center',
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  lineNumber: {
    width: 44,
    paddingRight: spacing.xs,
    textAlign: 'right',
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  code: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: spacing.sm
  },
  codePressed: {
    backgroundColor: colors.bgRaised
  },
  codeText: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 18
  },
  addedWord: {
    backgroundColor: colors.diffAddedWordBg
  },
  deletedWord: {
    backgroundColor: colors.diffDeletedWordBg
  },
  notes: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2
  },
  noteButton: {
    minWidth: 32,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  noteButtonPressed: {
    opacity: 0.72
  }
})
