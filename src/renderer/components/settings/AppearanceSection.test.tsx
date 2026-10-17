/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_UI_SETTINGS,
  MAX_IMPORTED_THEMES,
  type UiSettingsPatch,
} from '../../../shared/settings-types';
import { useSettingsStore } from '../../state/settings-store';
import { parseVsCodeThemeFile } from '../../styles/vscode-theme-import';
import { AppearanceSection } from './AppearanceSection';

vi.mock('../../terminal/terminal-host', () => ({ applyTerminalSettings: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const THEME_JSONC = `{
  // exportado de uma extensão
  "name": "night-owl",
  "type": "dark",
  "colors": {
    "editor.background": "#011627",
    "editor.foreground": "#d6deeb",
    "focusBorder": "#7e57c2",
    "button.background": "#7e57c2",
  },
}`;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const update = vi.fn(async () => {});
const updateUi = vi.fn(async (patch: UiSettingsPatch) => {
  useSettingsStore.setState((state) => ({ ui: { ...state.ui, ...patch } }));
});

function mount(): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<AppearanceSection />));
  return host;
}

async function pickFile(container: HTMLElement, file: File): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function radio(container: HTMLElement, label: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${label}"]`)!;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  )!;
}

async function clickAndSettle(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  update.mockClear();
  updateUi.mockClear();
  useSettingsStore.setState({
    terminal: DEFAULT_TERMINAL_SETTINGS,
    ui: DEFAULT_UI_SETTINGS,
    update,
    updateUi,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('Aparência → importar tema do VS Code', () => {
  it('o botão abre o seletor de .json', () => {
    const container = mount();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toContain('.json');
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Importar tema do VS Code',
    )!;
    act(() => button.click());
    expect(click).toHaveBeenCalledOnce();
  });

  it('importa o arquivo, persiste nas settings e marca o tema como em uso', async () => {
    const container = mount();
    await pickFile(container, new File([THEME_JSONC], 'night-owl-color-theme.json'));

    expect(updateUi).toHaveBeenCalledOnce();
    const patch = updateUi.mock.calls[0]![0];
    expect(patch.activeImportedThemeId).toBe('vscode-night-owl');
    expect(patch.importedThemes?.map((theme) => theme.label)).toEqual(['Night Owl']);
    expect(patch.importedThemes?.[0]!.ui.bg).toBe('#011627');

    const imported = radio(container, 'Paleta Night Owl, importada do VS Code');
    expect(imported.getAttribute('aria-checked')).toBe('true');
    expect(radio(container, 'Paleta Pink City').getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('explica um arquivo que não é tema e não grava nada', async () => {
    const container = mount();
    await pickFile(container, new File(['{"name": "x"}'], 'package.json'));
    expect(updateUi).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
      /tema de cores do VS Code/,
    );
  });

  it('voltar a um tema embutido desliga o importado; remover apaga da lista', async () => {
    const container = mount();
    await pickFile(container, new File([THEME_JSONC], 'night-owl.json'));
    updateUi.mockClear();

    const remove = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Remover Night Owl',
    )!;
    await act(async () => remove.click());
    expect(updateUi).toHaveBeenLastCalledWith({
      importedThemes: [],
      activeImportedThemeId: '',
    });

    await pickFile(container, new File([THEME_JSONC], 'night-owl.json'));
    updateUi.mockClear();
    await act(async () => radio(container, 'Paleta Dracula').click());
    expect(update).toHaveBeenCalledWith({ themeId: 'dracula' });
    expect(updateUi).toHaveBeenCalledWith({ activeImportedThemeId: '' });
  });
});

describe('Aparência → criar tema (Salvar tema)', () => {
  const editor = (container: HTMLElement) => container.querySelector('[role="dialog"]');
  const status = (container: HTMLElement) => container.querySelector('[role="status"]');
  const alert = (container: HTMLElement) => container.querySelector('[role="alert"]');
  const openEditor = (container: HTMLElement) =>
    clickAndSettle(button(container, 'Criar tema…'));
  const saveTheme = (container: HTMLElement) =>
    clickAndSettle(button(container, 'Salvar tema'));

  it('persiste o tema, fecha o editor e confirma com role="status"', async () => {
    const container = mount();
    await openEditor(container);
    expect(editor(container)).not.toBeNull();
    await saveTheme(container);

    expect(updateUi).toHaveBeenCalledOnce();
    const patch = updateUi.mock.calls[0]![0];
    expect(patch.activeImportedThemeId).toBe('custom-meu-tema');
    expect(patch.importedThemes?.map((theme) => theme.label)).toEqual(['Meu tema']);
    expect(editor(container)).toBeNull();
    expect(status(container)?.textContent).toBe('Tema salvo.');
    expect(alert(container)).toBeNull();
  });

  it('reabrir o editor apaga a confirmação anterior', async () => {
    const container = mount();
    await openEditor(container);
    await saveTheme(container);
    expect(status(container)).not.toBeNull();

    await openEditor(container);
    expect(editor(container)).not.toBeNull();
    expect(status(container)).toBeNull();
  });

  it('se a gravação falha, mantém o editor aberto e mostra o motivo; tentar de novo confirma', async () => {
    updateUi.mockRejectedValueOnce(new Error('Não consegui gravar as configurações.'));
    const container = mount();
    await openEditor(container);
    await saveTheme(container);

    expect(alert(container)?.textContent).toBe('Não consegui gravar as configurações.');
    expect(editor(container)).not.toBeNull();
    expect(status(container)).toBeNull();

    await saveTheme(container);
    expect(updateUi).toHaveBeenCalledTimes(2);
    expect(alert(container)).toBeNull();
    expect(editor(container)).toBeNull();
    expect(status(container)?.textContent).toBe('Tema salvo.');
  });

  it('uma falha sem mensagem usa o texto padrão', async () => {
    updateUi.mockRejectedValueOnce('ipc fechado');
    const container = mount();
    await openEditor(container);
    await saveTheme(container);

    expect(alert(container)?.textContent).toBe('Não foi possível salvar esse tema.');
    expect(editor(container)).not.toBeNull();
    expect(status(container)).toBeNull();
  });

  it('no limite de temas o erro do upsert (síncrono) aparece e nada é gravado', async () => {
    const themes = Array.from({ length: MAX_IMPORTED_THEMES }, (_, index) =>
      parseVsCodeThemeFile({
        name: `Tema ${index}`,
        colors: { 'editor.background': '#101014', 'editor.foreground': '#f0f0f0' },
      }),
    );
    useSettingsStore.setState({ ui: { ...DEFAULT_UI_SETTINGS, importedThemes: themes } });
    const container = mount();
    await openEditor(container);
    await saveTheme(container);

    expect(updateUi).not.toHaveBeenCalled();
    expect(alert(container)?.textContent).toMatch(
      new RegExp(`Limite de ${MAX_IMPORTED_THEMES} temas importados`),
    );
    expect(editor(container)).not.toBeNull();
    expect(status(container)).toBeNull();
  });
});
