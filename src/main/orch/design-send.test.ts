import { describe, expect, it, vi } from 'vitest';
import type { BrowserDesignElementContext } from '../../shared/browser-design';
import { sendDesignSelectionToAgent, type DesignSendDeps } from './design-send';

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
