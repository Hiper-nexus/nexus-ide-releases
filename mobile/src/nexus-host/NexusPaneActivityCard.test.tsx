import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  View: 'View',
  Text: 'Text'
}))

import { NexusPaneActivityBadge, NexusPaneActivityCard } from './NexusPaneActivityCard'

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => [node.props.children].flat().join(''))
}

describe('cartão de atividade do pane (MOB-05)', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('mostra palavra, o que fazer e há quanto tempo, também para leitor de tela', () => {
    act(() => {
      renderer = create(
        createElement(NexusPaneActivityCard, {
          view: { activity: 'waiting', at: 1_000, previous: 'working' },
          now: 1_000 + 4 * 60_000
        })
      )
    })
    expect(texts(renderer!)).toEqual([
      'Esperando você',
      'há 4 min',
      'O agente parou numa pergunta ou permissão. Responda pelo comando ou pela aprovação.'
    ])
    const card = renderer!.root.find((node) => node.props.accessibilityRole === 'summary')
    expect(card.props.accessibilityLabel).toBe(
      'Atividade: Esperando você, há 4 min. O agente parou numa pergunta ou permissão. Responda pelo comando ou pela aprovação.'
    )
    expect(card.props.accessibilityLiveRegion).toBe('polite')
  })

  it('terminou depois de trabalhar; sem atividade conhecida não há cartão', () => {
    act(() => {
      renderer = create(
        createElement(NexusPaneActivityCard, { view: { activity: 'idle', at: 0, previous: 'working' } })
      )
    })
    expect(texts(renderer!)).toEqual(['Terminou', 'O turno acabou e o pane está livre.'])
    act(() => renderer!.update(createElement(NexusPaneActivityCard, { view: null })))
    expect(renderer!.toJSON()).toBeNull()
  })

  it('selo da linha: palavra da atividade, ou o estado cru sem leitura', () => {
    act(() => {
      renderer = create(
        createElement(NexusPaneActivityBadge, {
          view: { activity: 'working', at: 1, previous: null },
          fallback: 'busy'
        })
      )
    })
    expect(texts(renderer!)).toEqual(['Trabalhando'])
    act(() => renderer!.update(createElement(NexusPaneActivityBadge, { view: null, fallback: 'parked' })))
    expect(texts(renderer!)).toEqual(['parked'])
  })
})
