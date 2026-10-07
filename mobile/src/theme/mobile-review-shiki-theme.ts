import type { ThemeRegistration } from '@shikijs/core'
import { colors } from './mobile-theme'

// Why: the review highlighter must paint with the Nexus mobile syntax tokens, not a
// bundled upstream theme. Scopes follow the Dark+ mapping these token values come from.
export const MOBILE_REVIEW_SHIKI_THEME_NAME = 'nexus-mobile-review'

export const mobileReviewShikiTheme: ThemeRegistration = {
  name: MOBILE_REVIEW_SHIKI_THEME_NAME,
  type: 'dark',
  fg: colors.textPrimary,
  bg: colors.editorSurface,
  colors: {
    'editor.foreground': colors.textPrimary,
    'editor.background': colors.editorSurface
  },
  tokenColors: [
    { settings: { foreground: colors.textPrimary } },
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: colors.syntaxComment }
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'constant.language',
        'variable.language',
        'entity.name.tag',
        'support.type.primitive',
        'punctuation.definition.template-expression'
      ],
      settings: { foreground: colors.syntaxKeyword }
    },
    {
      scope: ['keyword.control', 'meta.preprocessor', 'keyword.other.directive', 'meta.decorator'],
      settings: { foreground: colors.syntaxMeta }
    },
    { scope: ['keyword.operator'], settings: { foreground: colors.textPrimary } },
    {
      scope: ['string', 'punctuation.definition.string', 'string.regexp', 'markup.inline.raw'],
      settings: { foreground: colors.syntaxString }
    },
    {
      scope: ['constant.numeric', 'constant.character', 'keyword.other.unit'],
      settings: { foreground: colors.syntaxNumber }
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.name.namespace',
        'entity.other.inherited-class',
        'support.type',
        'support.class'
      ],
      settings: { foreground: colors.syntaxType }
    },
    {
      scope: ['entity.name.function', 'support.function', 'variable.function'],
      settings: { foreground: colors.syntaxFunction }
    },
    {
      scope: [
        'variable',
        'variable.parameter',
        'variable.other',
        'support.variable',
        'meta.object-literal.key',
        'entity.other.attribute-name',
        'support.type.property-name'
      ],
      settings: { foreground: colors.syntaxVariable }
    },
    {
      scope: ['markup.heading', 'entity.name.section'],
      settings: { foreground: colors.syntaxKeyword }
    }
  ]
}
