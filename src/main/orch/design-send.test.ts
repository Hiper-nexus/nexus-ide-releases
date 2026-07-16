import { describe, expect, it, vi } from 'vitest';
import type { BrowserDesignElementContext } from '../../shared/browser-design';
import {
  sendDesignAnnotationsToAgent,
  sendDesignSelectionToAgent,
  type DesignAnnotationsSendDeps,
  type DesignSendDeps,
} from './design-send';

const SELECTION: BrowserDesignElementContext = {
  ref: 'e1',
  tag: 'button',
  id: 'save',
  classes: ['btn-primary'],
  selector: '#save',
  rect: { x: 12, y: 34, width: 120, height: 40 },
  text: 'Salvar',
  outerHtml: '<button id="save">Salvar</button>',
  attributes: { id: 'save' },
  computedStyles: { display: 'inline-block' },
  url: 'http://localhost:5173/',
  frameworkHints: {
    framework: 'react',
    componentName: 'SaveButton',
    ownerChain: ['SaveButton', 'App'],
  },
};

function makeDeps(overrides: Partial<DesignSendDeps> = {}): DesignSendDeps {
  return {
    getSelection: vi.fn(() => SELECTION),
    getSelections: vi.fn(() => [SELECTION]),
    findPane: vi.fn(() => ({ paneId: 'pane-cli', sessionId: 'sess-1' })),
    workspaceRoot: vi.fn(() => '/ws'),
    search: vi.fn(async () => [
      {
        file: 'src/SaveButton.tsx',
        line: 3,
        score: 90,
        matched: ['component:SaveButton'],
      },
    ]),
    capture: vi.fn(async () => ({ path: '/tmp/element.png' })),
    inject: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('sendDesignSelectionToAgent', () => {
  it('formats the selection and injects it into the target pane session', async () => {
    const deps = makeDeps();
    const result = await sendDesignSelectionToAgent(
      {
        paneId: 'pane-browser',
        targetPaneRef: 'pane-cli',
        instruction: 'deixa esse botão verde',
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      targetPaneId: 'pane-cli',
      targetSessionId: 'sess-1',
    });
    expect(deps.inject).toHaveBeenCalledTimes(1);
    const [sessionId, prompt] = (deps.inject as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string];
    expect(sessionId).toBe('sess-1');
    expect(prompt).toContain('#save');
    expect(prompt).toContain('SaveButton');
    expect(prompt).toContain('src/SaveButton.tsx:3');
    expect(prompt).toContain('/tmp/element.png');
    expect(prompt).toContain('deixa esse botão verde');
    expect(result.promptChars).toBe(prompt.length);
    expect(deps.capture).toHaveBeenCalledWith('pane-browser', SELECTION.rect);
  });

  it('dryRun prepares the prompt + screenshot but does NOT inject, returning the prompt for copy', async () => {
    const deps = makeDeps();
    const result = await sendDesignSelectionToAgent(
      {
        paneId: 'pane-browser',
        targetPaneRef: 'pane-cli',
        instruction: 'deixa esse botão verde',
        dryRun: true,
      },
      deps,
    );

    // Nothing reaches the target PTY in dry-run mode.
    expect(deps.inject).not.toHaveBeenCalled();
    // The screenshot is still captured (the copy may reference it) and the
    // fully-formatted prompt is returned for clipboard copy.
    expect(deps.capture).toHaveBeenCalledTimes(1);
    expect(result.prompt).toBeDefined();
    expect(result.prompt).toContain('#save');
    expect(result.prompt).toContain('SaveButton');
    expect(result.prompt).toContain('deixa esse botão verde');
    expect(result.promptChars).toBe(result.prompt!.length);
    expect(result.designSystemAttached).toBeUndefined();
  });

  it('attaches a workspace DESIGN.md as trusted design-system context and flags it', async () => {
    const deps = makeDeps();
    const result = await sendDesignSelectionToAgent(
      {
        paneId: 'pane-browser',
        targetPaneRef: 'pane-cli',
        instruction: 'deixa on-brand',
        designSystem:
          '---\nname: Linear\ncolors:\n  primary: "#5e6ad2"\n---\n\n## Overview\nUltra-minimal.',
      },
      deps,
    );

    expect(result.designSystemAttached).toBe(true);
    const [sessionId, prompt] = (deps.inject as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string];
    expect(sessionId).toBe('sess-1');
    // DESIGN.md rides in its own trusted block, after the untrusted page data.
    expect(prompt).toContain('BEGIN_DESIGN_SYSTEM');
    expect(prompt).toContain('#5e6ad2');
    expect(prompt).toContain('Ultra-minimal.');
    expect(prompt.indexOf('END_UNTRUSTED_PAGE_DATA')).toBeLessThan(
      prompt.indexOf('BEGIN_DESIGN_SYSTEM'),
    );
  });

  it('forwards a style diff (F2 Apply) into the injected prompt', async () => {
    const deps = makeDeps();
    await sendDesignSelectionToAgent(
      {
        paneId: 'pane-browser',
        targetPaneRef: 'pane-cli',
        styleDiff: { 'background-color': { from: 'blue', to: '#16a34a' } },
      },
      deps,
    );
    const [, prompt] = (deps.inject as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(prompt).toContain('background-color: blue → #16a34a');
  });

  it('multi-selection extras flow into the prompt (F4)', async () => {
    const extra = { ...SELECTION, ref: 'e2', selector: '.card:nth-of-type(2)', id: undefined };
    const deps = makeDeps({ getSelections: vi.fn(() => [extra, SELECTION]) });
    await sendDesignSelectionToAgent(
      { paneId: 'pane-browser', targetPaneRef: 'pane-cli' },
      deps,
    );
    const [, prompt] = (deps.inject as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(prompt).toContain('Elementos adicionais na seleção (1)');
    expect(prompt).toContain('.card:nth-of-type(2)');
  });

  it('clone intent skips the workspace search and asks for recreation (F4)', async () => {
    const deps = makeDeps();
    await sendDesignSelectionToAgent(
      { paneId: 'pane-browser', targetPaneRef: 'pane-cli', intent: 'clone' },
      deps,
    );
    expect(deps.search).not.toHaveBeenCalled();
    const [, prompt] = (deps.inject as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(prompt.toLowerCase()).toContain('recrie');
  });

  it('fails when the browser pane has no selection', async () => {
    const deps = makeDeps({ getSelection: vi.fn(() => null) });
    await expect(
      sendDesignSelectionToAgent(
        { paneId: 'pane-browser', targetPaneRef: 'pane-cli' },
        deps,
      ),
    ).rejects.toThrow(/no design selection/i);
    expect(deps.inject).not.toHaveBeenCalled();
  });

  it('fails when the target pane is unknown or has no live session', async () => {
    await expect(
      sendDesignSelectionToAgent(
        { paneId: 'pane-browser', targetPaneRef: 'ghost' },
        makeDeps({ findPane: vi.fn(() => null) }),
      ),
    ).rejects.toThrow(/unknown target pane/i);

    await expect(
      sendDesignSelectionToAgent(
        { paneId: 'pane-browser', targetPaneRef: 'pane-cli' },
        makeDeps({ findPane: vi.fn(() => ({ paneId: 'pane-cli' })) }),
      ),
    ).rejects.toThrow(/no live session/i);
  });

  it('screenshot and search failures degrade instead of blocking the send', async () => {
    const deps = makeDeps({
      capture: vi.fn(async () => {
        throw new Error('pane hidden');
      }),
      search: vi.fn(async () => {
        throw new Error('walk failed');
      }),
    });
    const result = await sendDesignSelectionToAgent(
      { paneId: 'pane-browser', targetPaneRef: 'pane-cli' },
      deps,
    );
    expect(result.ok).toBe(true);
    const [, prompt] = (deps.inject as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(prompt).toContain('#save');
    expect(prompt).not.toContain('element.png');
  });

  it('an unresolvable workspace only drops the candidates section', async () => {
    const deps = makeDeps({
      workspaceRoot: vi.fn(() => {
        throw new Error('no workspace');
      }),
    });
    const result = await sendDesignSelectionToAgent(
      { paneId: 'pane-browser', targetPaneRef: 'pane-cli' },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.inject).toHaveBeenCalledTimes(1);
  });

  it('refuses to inject context when the selection changes during enrichment', async () => {
    let selected: BrowserDesignElementContext = SELECTION;
    let releaseSearch: (() => void) | undefined;
    const search = vi.fn(
      () =>
        new Promise<[]>(resolve => {
          releaseSearch = () => resolve([]);
        }),
    );
    const deps = makeDeps({
      getSelection: vi.fn(() => selected),
      getSelections: vi.fn(() => [selected]),
      search,
    });

    const pending = sendDesignSelectionToAgent(
      { paneId: 'pane-browser', targetPaneRef: 'pane-cli' },
      deps,
    );
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    selected = { ...SELECTION, ref: 'e2', id: 'newer' };
    releaseSearch?.();

    await expect(pending).rejects.toThrow(/selection changed/i);
    expect(deps.inject).not.toHaveBeenCalled();
  });
});

describe('sendDesignAnnotationsToAgent (batch, Orca Design Mode parity)', () => {
  const ANNOTATION = {
    id: 'a1',
    comment: 'aumentar o contraste',
    intent: 'fix' as const,
    priority: 'suggestion' as const,
    createdAt: 1_700_000_000_000,
    label: 'button#save "Salvar"',
    selection: SELECTION,
  };

  function makeBatchDeps(
    overrides: Partial<DesignAnnotationsSendDeps> = {},
  ): DesignAnnotationsSendDeps {
    return {
      getAnnotations: vi.fn(() => [ANNOTATION]),
      findPane: vi.fn(() => ({ paneId: 'pane-cli', sessionId: 'sess-1' })),
      inject: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('formats ALL annotations into one prompt and injects it', async () => {
    const deps = makeBatchDeps({
      getAnnotations: vi.fn(() => [
        ANNOTATION,
        { ...ANNOTATION, id: 'a2', comment: 'centralizar o card', intent: 'change' as const },
      ]),
    });
    const result = await sendDesignAnnotationsToAgent(
      { paneId: 'pane-browser', targetPaneRef: 'pane-cli' },
      deps,
    );
    expect(result).toMatchObject({
      ok: true,
      targetPaneId: 'pane-cli',
      targetSessionId: 'sess-1',
      annotations: 2,
    });
    const [, prompt] = (deps.inject as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string];
    expect(prompt).toContain('1. [corrigir] aumentar o contraste');
    expect(prompt).toContain('2. [mudar] centralizar o card');
    expect(result.prompt).toBeUndefined();
  });

  it('dryRun returns the prompt for clipboard copy without injecting', async () => {
    const deps = makeBatchDeps();
    const result = await sendDesignAnnotationsToAgent(
      { paneId: 'pane-browser', targetPaneRef: 'pane-cli', dryRun: true },
      deps,
    );
    expect(deps.inject).not.toHaveBeenCalled();
    expect(result.prompt).toContain('BEGIN_UNTRUSTED_PAGE_DATA');
    expect(result.promptChars).toBe(result.prompt!.length);
  });

  it('attaches DESIGN.md as trusted context and flags it', async () => {
    const deps = makeBatchDeps();
    const result = await sendDesignAnnotationsToAgent(
      {
        paneId: 'pane-browser',
        targetPaneRef: 'pane-cli',
        dryRun: true,
        designSystem: '# Tokens',
      },
      deps,
    );
    expect(result.designSystemAttached).toBe(true);
    expect(result.prompt).toContain('BEGIN_DESIGN_SYSTEM');
  });

  it('fails without annotations, unknown target, or dead session', async () => {
    await expect(
      sendDesignAnnotationsToAgent(
        { paneId: 'pane-browser', targetPaneRef: 'pane-cli' },
        makeBatchDeps({ getAnnotations: vi.fn(() => []) }),
      ),
    ).rejects.toThrow(/no design annotations/);
    await expect(
      sendDesignAnnotationsToAgent(
        { paneId: 'pane-browser', targetPaneRef: 'pane-x' },
        makeBatchDeps({ findPane: vi.fn(() => null) }),
      ),
    ).rejects.toThrow(/unknown target pane/);
    await expect(
      sendDesignAnnotationsToAgent(
        { paneId: 'pane-browser', targetPaneRef: 'pane-cli' },
        makeBatchDeps({ findPane: vi.fn(() => ({ paneId: 'pane-cli' })) }),
      ),
    ).rejects.toThrow(/no live session/);
  });
});
