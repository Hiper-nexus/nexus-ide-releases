import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Build nativo real do LegendList (alias do vitest.config.ts) sobre o mock de RN
// compartilhado — sem FlatList: a lista do host Nexus é a mesma do caminho Orca (MOB-01).
vi.mock('react-native', async () => {
  const { createLegendListReactNativeMock } = await import(
    '../test-support/legend-list-react-native-mock'
  )
  return createLegendListReactNativeMock()
})
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  FileText: 'FileText',
  Folder: 'Folder',
  Lock: 'Lock',
  RefreshCw: 'RefreshCw',
  MessageSquare: 'MessageSquare'
}))
vi.mock('../session/use-mobile-diff-review-block-highlights', () => ({
  useMobileDiffReviewBlockHighlights: () => ({
    highlightVersion: 0,
    onViewableItemsChanged: () => {},
    tokensForRow: () => null,
    viewabilityConfig: {}
  })
}))

import type { NexusWorkspaceApi } from '../transport/nexus-bridge-git-files'
import { NexusPaneWorkspace } from './NexusPaneWorkspace'

const ENTRY_COUNT = 2_000
const LINE_COUNT = 5_000

function workspace(): NexusWorkspaceApi {
  return {
    gitStatus: async () => {
      throw new Error('não usado')
    },
    gitDiff: async () => {
      throw new Error('não usado')
    },
    listFiles: async () => ({
      path: '',
      truncated: false,
      entries: Array.from({ length: ENTRY_COUNT }, (_, index) => ({
        name: `arquivo-${index}.ts`,
        path: `arquivo-${index}.ts`,
        kind: 'file' as const
      }))
    }),
    readFile: async (_paneId, path) => ({
      path,
      truncated: false,
      binary: false,
      byteLength: LINE_COUNT * 10,
      content: Array.from({ length: LINE_COUNT }, (_, index) => `linha ${index + 1}`).join('\n')
    })
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('arquivos do pane no host Nexus: lista virtualizada (MOB-01)', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('uma pasta de 2.000 entradas e um arquivo de 5.000 linhas montam só o que cabe na tela', async () => {
    await act(async () => {
      renderer = create(
        createElement(NexusPaneWorkspace, {
          paneId: 'pane-app',
          workspace: workspace(),
          view: 'files',
          onViewChange: () => {}
        })
      )
    })
    await flush()
    const rows = () =>
      renderer!.root.findAll(
        (node) =>
          (node.type as unknown) === 'Pressable' &&
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('Ler arquivo-')
      )
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().length).toBeLessThan(200)

    // Abre um arquivo: as linhas numeradas também são virtualizadas.
    await act(async () => {
      rows()[0]!.props.onPress()
    })
    await flush()
    const lineNumbers = renderer!.root.findAll(
      (node) => (node.type as unknown) === 'Text' && /^\d+$/.test(String(node.props.children))
    )
    expect(lineNumbers.length).toBeGreaterThan(0)
    expect(lineNumbers.length).toBeLessThan(500)
    expect(lineNumbers[0]!.props.children).toBe(1)
  })
})

// F-1037: a ordem das seções segue o painel Git do desktop.
describe('alterações do pane no host Nexus: ordem das seções', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('mostra Preparadas, depois Alteradas, depois Novas', async () => {
    const base = workspace()
    const status: Awaited<ReturnType<NexusWorkspaceApi['gitStatus']>> = {
      entries: [
        { path: 'novo.ts', status: 'untracked', area: 'untracked', letter: '?', restricted: false },
        { path: 'README.md', status: 'modified', area: 'unstaged', letter: 'M', restricted: false },
        { path: 'src/app.ts', status: 'modified', area: 'staged', letter: 'M', restricted: false }
      ],
      branch: 'main',
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
      conflictOperation: 'unknown',
      clean: false,
      truncated: false
    }
    await act(async () => {
      renderer = create(
        createElement(NexusPaneWorkspace, {
          paneId: 'pane-app',
          workspace: { ...base, gitStatus: async () => status },
          view: 'changes',
          onViewChange: () => {}
        })
      )
    })
    await flush()
    const sections = renderer!.root
      .findAll((node) => (node.type as unknown) === 'Text')
      .map((node) => [node.props.children].flat().join(''))
      .filter((text) => / · \d+$/.test(text))
    expect(sections).toEqual([
      'Preparadas para commit · 1',
      'Alteradas · 1',
      'Novas (fora do Git) · 1'
    ])
  })
})
