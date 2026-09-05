import { useEffect, useMemo, useRef, useState } from 'react';
import { openWorkspaceSchema } from '../../shared/workspace-types';
import { MAX_LIVE_PANES_HARD } from '../../shared/pane-limits';
import { useTerminalGridDialogStore } from '../state/terminal-grid-dialog-store';
import { useLayoutStore } from '../state/layout-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useProviderStore } from '../state/provider-store';
import { useAccountStore } from '../state/account-store';
import { askConfirm, useConfirmStore } from '../state/confirm-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { createPane, isStructuralPlaceholderPane, listPanes } from '../lib/split-tree';
import { buildPanePickerEntries } from './PanePicker';
import { PixelIcon } from './PixelIcon';
import { SHELL_ENTRY_ID, TERMINAL_LAYOUT_COUNTS, TerminalAgentsStep, TerminalLaunchSummary, TerminalLayoutStep } from './TerminalGridPanels';

const MAX_SETUP_PANES = TERMINAL_LAYOUT_COUNTS[TERMINAL_LAYOUT_COUNTS.length - 1];
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled)';

function TerminalGridSetup({ initialCount, close }: { initialCount: number; close(): void }) {
  const current = useWorkspaceStore(state => state.current);
  const recents = useWorkspaceStore(state => state.recents);
  const providers = useProviderStore(state => state.providers);
  const accounts = useAccountStore(state => state.accounts);
  const layoutRoot = useLayoutStore(state => state.root);
  const [count, setCount] = useState(Number.isFinite(initialCount) ? Math.max(1, Math.min(MAX_SETUP_PANES, Math.trunc(initialCount))) : 2);
  const [step, setStep] = useState<'layout' | 'agents'>('layout');
  const [folder, setFolder] = useState(current?.path ?? '');
  const [selections, setSelections] = useState<string[]>(Array(MAX_SETUP_PANES).fill(SHELL_ENTRY_ID));
  const [operation, setOperation] = useState<'pick-folder' | 'open-panels' | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const entries = useMemo(() => buildPanePickerEntries(providers, accounts).filter(entry => entry.intent.kind !== 'browser'), [providers, accounts]);
  const existingCount = listPanes(layoutRoot).filter(pane => !isStructuralPlaceholderPane(pane)).length;

  useEffect(() => {
    const previousFocus = document.activeElement;
    panelRef.current?.querySelector<HTMLElement>('[aria-label="Escolher pasta"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (useConfirmStore.getState().pending) return;
      event.stopImmediatePropagation();
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) close();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(el => !el.closest('fieldset:disabled'));
        const index = controls.findIndex(el => el === document.activeElement);
        const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
        controls[next]?.focus();
      } else if (event.key === 'Enter' && document.activeElement instanceof HTMLButtonElement) {
        event.preventDefault();
        document.activeElement.click();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [close]);

  function changeStep(next: 'layout' | 'agents'): void {
    setStep(next);
    setError('');
    headingRef.current?.focus();
  }

  async function pickFolder(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setOperation('pick-folder');
    setError('');
    try {
      const path = await window.nexus.workspace.pickPath();
      if (path) setFolder(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível escolher a pasta.');
    } finally {
      busyRef.current = false;
      setOperation(null);
    }
  }

  async function launch(withAgents: boolean): Promise<void> {
    if (busyRef.current) return;
    const parsed = openWorkspaceSchema.safeParse({ path: folder.trim() });
    if (!parsed.success) { setError('Escolha uma pasta de trabalho válida.'); return; }
    const chosen = selections.slice(0, count).map(id => entries.find(entry => entry.id === (withAgents ? id : SHELL_ENTRY_ID)));
    if (chosen.some(entry => !entry)) { setError('Uma ferramenta ficou indisponível. Revise a escolha de cada painel.'); return; }
    busyRef.current = true;
    setOperation('open-panels');
    setError('');
    try {
      if (useWorkspaceStore.getState().current?.path !== parsed.data.path) {
        const openPanes = listPanes(useLayoutStore.getState().root).filter(pane => !isStructuralPlaceholderPane(pane));
        if (useWorkspaceStore.getState().current && openPanes.length > 0) {
          const confirmed = await askConfirm({
            title: 'Trocar de projeto?',
            body: `Abrir ${parsed.data.path} encerra os ${openPanes.length} terminais do projeto atual. O layout fica salvo para reabrir depois, mas os processos em execução serão encerrados.`,
            confirmLabel: 'Trocar e abrir terminais',
            danger: true,
          });
          if (!confirmed) return;
        }
        await useWorkspaceStore.getState().open(parsed.data.path);
      }
      const cwd = useWorkspaceStore.getState().current?.path;
      if (!cwd) throw new Error('Abra uma pasta de projeto para continuar.');
      const latestEntries = buildPanePickerEntries(useProviderStore.getState().providers, useAccountStore.getState().accounts);
      if (chosen.some(entry => !latestEntries.some(latest => latest.id === entry!.id))) throw new Error('Uma ferramenta ficou indisponível. Revise a escolha de cada painel.');
      const existing = listPanes(useLayoutStore.getState().root).filter(pane => !isStructuralPlaceholderPane(pane));
      if (existing.length + count > MAX_LIVE_PANES_HARD) throw new Error(`O limite é de ${MAX_LIVE_PANES_HARD} painéis. Feche alguns terminais antes de continuar.`);
      const panes = chosen.map(entry => {
        const intent = entry!.intent;
        if (intent.kind !== 'agent') return createPane('shell', cwd);
        return { ...createPane('cli-agent', cwd, intent.adapterId, intent.model), ...(intent.accountId ? { accountId: intent.accountId } : {}) };
      });
      const layout = useLayoutStore.getState();
      layout.setPanes([...existing, ...panes]);
      if (layout.viewKind !== 'grid') layout.toggleView();
      useLayoutStore.getState().focus(panes[0].id);
      useProductNavigationStore.getState().openTerminal();
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível abrir os terminais. Tente novamente.');
    } finally {
      busyRef.current = false;
      setOperation(null);
    }
  }

  return (
    <div className="terminal-setup" role="dialog" aria-modal="true" aria-labelledby="terminal-setup-title" aria-describedby="terminal-setup-description">
      <div className="terminal-setup__overlay" onClick={() => { if (!busyRef.current) close(); }} />
      <div className="terminal-setup__panel" ref={panelRef} aria-busy={busy}>
        <header className="terminal-setup__header">
          <div className="terminal-setup__step-heading">
          <p className="terminal-setup__step-count">Etapa {step === 'layout' ? '1' : '2'} de 2</p>
          <ol className="terminal-setup__steps" aria-label="Etapas da configuração">
            <li aria-current={step === 'layout' ? 'step' : undefined} data-complete={step === 'agents'}><span>{step === 'agents' ? <PixelIcon name="check" size={12} /> : '1'}</span>Pasta e painéis</li>
            <li aria-current={step === 'agents' ? 'step' : undefined}><span>2</span>Ferramentas</li>
          </ol>
          </div>
          <button type="button" className="terminal-setup__close" aria-label="Fechar configuração" onClick={close} disabled={busy}><PixelIcon name="close" size={14} /></button>
          <h2 id="terminal-setup-title" ref={headingRef} tabIndex={-1}>{step === 'layout' ? 'Escolha a pasta e os painéis' : 'Defina o que abre em cada painel'}</h2>
          <p id="terminal-setup-description">{step === 'layout'
            ? 'Um painel é uma área independente da tela para conversar com uma IA ou digitar comandos.'
            : 'As ferramentas de IA funcionam aqui em aplicativos de terminal (CLIs). Você pode usar uma diferente em cada painel.'}</p>
        </header>
        <fieldset className="terminal-setup__body" disabled={busy}>
          {step === 'layout' ? <TerminalLayoutStep count={count} onCount={setCount} folder={folder} onFolder={setFolder} recents={recents} onPickFolder={() => void pickFolder()} /> : (
            <TerminalAgentsStep selections={selections.slice(0, count)} entries={entries} onSelect={(index, id) => setSelections(previous => previous.map((value, i) => i === index ? id : value))} onApplyAll={() => setSelections(previous => previous.map((value, i) => i < count ? previous[0] : value))} onConfigure={() => { close(); useProductNavigationStore.getState().openSettings('providers'); }} />
          )}
        </fieldset>
        <footer className="terminal-setup__footer">
          <TerminalLaunchSummary folder={folder} count={count} entries={entries} selections={step === 'agents' ? selections.slice(0, count) : undefined} />
          {error && <p className="terminal-setup__error" role="alert">{error}</p>}
          {operation && <p className="terminal-setup__progress" role="status">{operation === 'pick-folder' ? 'Escolhendo a pasta na janela do sistema…' : 'Abrindo os painéis na pasta escolhida…'}</p>}
          {existingCount > 0 && <p className="terminal-setup__preserve">{current && folder.trim() !== current.path ? 'Trocar de projeto encerra as sessões atuais. Você confirma antes de continuar.' : 'Os terminais já abertos serão mantidos.'}</p>}
          <div className="terminal-setup__actions">
            <button type="button" className="terminal-setup__quiet-button" disabled={busy} onClick={() => step === 'layout' ? close() : changeStep('layout')}>{step === 'layout' ? 'Cancelar' : 'Voltar ao layout'}</button>
            <div>
              {step === 'layout' && <button type="button" className="terminal-setup__quiet-button" disabled={busy || !folder.trim()} onClick={() => void launch(false)}>Abrir sem IA</button>}
              <button type="button" className="terminal-setup__primary" disabled={busy || !folder.trim()} onClick={() => step === 'layout' ? changeStep('agents') : void launch(true)}>
                {busy ? operation === 'pick-folder' ? 'Escolhendo pasta…' : 'Abrindo painéis…' : step === 'layout' ? 'Próximo: escolher IAs' : `Abrir ${count} ${count === 1 ? 'terminal' : 'terminais'}`}<PixelIcon name="arrow-right" size={12} />
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function TerminalGridDialog() {
  const isOpen = useTerminalGridDialogStore(state => state.isOpen);
  const options = useTerminalGridDialogStore(state => state.options);
  const close = useTerminalGridDialogStore(state => state.close);
  return isOpen ? <TerminalGridSetup initialCount={options.initialCount ?? 2} close={close} /> : null;
}
