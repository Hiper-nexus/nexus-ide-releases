/** @vitest-environment jsdom */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComposerTiptapEditor,
  tiptapJsonToMarkdown,
  type ComposerTiptapEditorHandle,
  type ComposerTiptapEditorProps,
} from './ComposerTiptapEditor';
import { parseInlineMarkdown } from '../../shared/rich-text-marks';

// F-1170: o editor como campo de escrita da missão — o que um <textarea>
// fazia (Enter, IME, foco, aria, maxLength, colar) e as marcas do markdown.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const geometry = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  for (const [name, value] of [['getClientRects', () => []], ['getBoundingClientRect', () => new DOMRect()]] as const) {
    geometry.set(name, Object.getOwnPropertyDescriptor(Range.prototype, name));
    Object.defineProperty(Range.prototype, name, { configurable: true, value });
  }
});
afterEach(async () => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  await new Promise((resolve) => setTimeout(resolve, 5));
  document.body.replaceChildren();
  for (const [name, original] of geometry) {
    if (original) Object.defineProperty(Range.prototype, name, original);
    else Reflect.deleteProperty(Range.prototype, name);
  }
  geometry.clear();
  vi.restoreAllMocks();
});

type Surface = HTMLElement & { editor: Editor };

async function setup(props: Partial<ComposerTiptapEditorProps> = {}) {
  const onChange = vi.fn();
  const ref = createRef<ComposerTiptapEditorHandle>();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = async (next: Partial<ComposerTiptapEditorProps> = {}) => {
    await act(async () => {
      root.render(<ComposerTiptapEditor ref={ref} value="" onChange={onChange} {...props} {...next} />);
    });
  };
  await render();
  const surface = host.querySelector<Surface>('[role="textbox"]');
  if (!surface?.editor) throw new Error('Real Tiptap editor did not mount');
  return { host, surface, editor: surface.editor, onChange, ref, render };
}

function keydown(surface: HTMLElement, init: KeyboardEventInit, keyCode?: number): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  act(() => { surface.dispatchEvent(event); });
  return event;
}

function typeText(editor: Editor, text: string): void {
  act(() => { editor.view.dispatch(editor.state.tr.insertText(text)); });
}

function paste(surface: HTMLElement, data: Record<string, string>): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => data[type] ?? '', types: Object.keys(data), files: [], items: [] },
  });
  act(() => { surface.dispatchEvent(event); });
  return event;
}

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

describe('F-1170: Enter envia, Shift+Enter quebra linha, IME não envia', () => {
  it('Enter chama onSubmit uma vez, previne o default e não altera o texto', async () => {
    const onSubmit = vi.fn();
    const { surface, editor, onChange } = await setup({ value: 'Revise', onSubmit });
    act(() => editor.commands.setTextSelection(7));
    const enter = keydown(surface, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(enter.defaultPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.state.doc.childCount).toBe(1);
  });

  it('Shift+Enter quebra a linha e não envia', async () => {
    const onSubmit = vi.fn();
    const { surface, editor, onChange } = await setup({ value: 'um', onSubmit });
    act(() => editor.commands.setTextSelection(3));
    keydown(surface, { key: 'Enter', shiftKey: true });
    typeText(editor, 'dois');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('um\ndois');
  });

  it('sem onSubmit, Enter continua criando um parágrafo', async () => {
    const { surface, editor, onChange } = await setup({ value: 'um' });
    act(() => editor.commands.setTextSelection(3));
    keydown(surface, { key: 'Enter' });
    typeText(editor, 'dois');
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('um\ndois');
  });

  it('Enter durante a composição do IME (isComposing ou keyCode 229) não envia, não previne e não vaza', async () => {
    const onSubmit = vi.fn();
    const appKeydown = vi.fn();
    const { surface, editor, onChange } = await setup({ value: 'ação', onSubmit });
    document.addEventListener('keydown', appKeydown);
    try {
      act(() => editor.commands.setTextSelection(5));
      const composing = keydown(surface, { key: 'Enter', isComposing: true });
      const legacy = keydown(surface, { key: 'Enter' }, 229);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(composing.defaultPrevented).toBe(false);
      expect(legacy.defaultPrevented).toBe(false);
      expect(appKeydown).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(editor.state.doc.childCount).toBe(1);
      keydown(surface, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', appKeydown);
    }
  });

  it('somente leitura não envia com Enter', async () => {
    const onSubmit = vi.fn();
    const { surface } = await setup({ value: 'x', onSubmit, editable: false });
    keydown(surface, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('F-1170: ref imperativa, id e atributos de acessibilidade', () => {
  it('focusEnd foca a superfície e põe o cursor no fim do documento (citação)', async () => {
    const { surface, editor, ref, render } = await setup({ value: 'abc' });
    await render({ value: 'abc\n\n> citação\n\n' });
    act(() => ref.current!.focusEnd());
    expect(document.activeElement).toBe(surface);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
    expect(editor.state.selection.$from.parent).toBe(editor.state.doc.lastChild);
  });

  it('focus foca sem mover o conteúdo', async () => {
    const { surface, ref, onChange } = await setup({ value: 'abc' });
    act(() => ref.current!.focus());
    expect(document.activeElement).toBe(surface);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('id, aria-labelledby, aria-describedby e aria-invalid chegam à superfície e acompanham as props', async () => {
    const { surface, render } = await setup({
      id: 'orientacao', ariaLabelledBy: 'rotulo', ariaDescribedBy: 'dica', ariaInvalid: false,
    });
    expect(surface.id).toBe('orientacao');
    expect(surface.getAttribute('aria-labelledby')).toBe('rotulo');
    expect(surface.getAttribute('aria-describedby')).toBe('dica');
    expect(surface.getAttribute('aria-invalid')).toBe('false');
    expect(surface.hasAttribute('aria-label')).toBe(false);
    await render({ ariaDescribedBy: 'dica erro', ariaInvalid: true });
    expect(surface.getAttribute('aria-describedby')).toBe('dica erro');
    expect(surface.getAttribute('aria-invalid')).toBe('true');
  });

  it('sem rótulo externo, aria-label nomeia a superfície; placeholder vai em aria-placeholder', async () => {
    const { surface } = await setup({ ariaLabel: 'Resposta livre', placeholder: 'Escreva' });
    expect(surface.getAttribute('aria-label')).toBe('Resposta livre');
    expect(surface.getAttribute('aria-placeholder')).toBe('Escreva');
  });

  it('editable=false marca aria-disabled e contenteditable=false', async () => {
    const { surface, render } = await setup({ editable: false });
    expect(surface.getAttribute('contenteditable')).toBe('false');
    expect(surface.getAttribute('aria-disabled')).toBe('true');
    await render({ editable: true });
    expect(surface.getAttribute('contenteditable')).toBe('true');
    expect(surface.hasAttribute('aria-disabled')).toBe(false);
  });

  it('toolbar={false} esconde a barra de formatação e mantém os atalhos', async () => {
    const { host, surface, editor, onChange } = await setup({ value: 'palavra', toolbar: false });
    expect(host.querySelector('[role="toolbar"]')).toBeNull();
    act(() => editor.commands.setTextSelection({ from: 1, to: 8 }));
    keydown(surface, { key: 'b', ...mod });
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('**palavra**');
  });
});

describe('F-1170: valor externo (ditado, exemplo) substitui sem perder cursor nem foco', () => {
  it('acréscimo externo no fim mantém o cursor onde estava e o foco', async () => {
    const { surface, editor, render, onChange } = await setup({ value: 'abcdef' });
    act(() => { editor.commands.setTextSelection(4); editor.view.focus(); });
    await render({ value: 'abcdef ditado' });
    expect(editor.state.doc.textContent).toBe('abcdef ditado');
    expect(editor.state.selection.from).toBe(4);
    expect(document.activeElement).toBe(surface);
    expect(onChange).not.toHaveBeenCalled();
    typeText(editor, 'X');
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('abcXdef ditado');
  });

  it('substituição por outro texto maior (exemplo) leva o cursor ao fim, como o textarea', async () => {
    const { surface, editor, render } = await setup({ value: 'rascunho' });
    act(() => { editor.commands.setTextSelection(3); editor.view.focus(); });
    await render({ value: 'crie uma página de contato simples' });
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
    expect(document.activeElement).toBe(surface);
  });

  it('substituição por um texto menor (exemplo) prende o cursor no novo fim', async () => {
    const { editor, render } = await setup({ value: 'um texto bem comprido' });
    act(() => editor.commands.setTextSelection(18));
    await render({ value: 'curto' });
    expect(editor.state.doc.textContent).toBe('curto');
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
  });

  it('valor externo acima do maxLength é exibido inteiro (nada se perde); o teto só barra digitação', async () => {
    const { editor, render } = await setup({ value: 'ab', maxLength: 4 });
    await render({ value: 'abcdefgh' });
    expect(editor.state.doc.textContent).toBe('abcdefgh');
  });
});

describe('F-1170: maxLength recusa ou trunca de forma visível', () => {
  it('digitação além do limite é recusada e o aviso aparece ligado à superfície', async () => {
    const { host, surface, editor, onChange } = await setup({ value: 'abcd', maxLength: 5 });
    act(() => editor.commands.setTextSelection(5));
    typeText(editor, 'e');
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('abcde');
    typeText(editor, 'f');
    expect(editor.state.doc.textContent).toBe('abcde');
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('abcde');
    const notice = host.querySelector<HTMLElement>('.composer-tiptap__limit');
    expect(notice?.textContent).toContain('Limite de 5 caracteres');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(surface.getAttribute('aria-describedby')?.split(' ')).toContain(notice!.id);
  });

  it('o limite conta o markdown canônico (marcas e escapes inclusos)', async () => {
    const { editor, onChange } = await setup({ value: '**ab**', maxLength: 7 });
    act(() => editor.commands.setTextSelection(3));
    typeText(editor, 'c');
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('**abc**');
    typeText(editor, 'd');
    expect(editor.state.doc.textContent).toBe('abc');
  });

  it('colar além do limite trunca o excedente e avisa', async () => {
    const { host, surface, editor, onChange } = await setup({ value: 'ab', maxLength: 6 });
    act(() => editor.commands.setTextSelection(3));
    paste(surface, { 'text/plain': 'cdefghij' });
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('abcdef');
    expect(host.querySelector('.composer-tiptap__limit')?.textContent).toContain('Limite de 6 caracteres');
  });

  it('apagar continua permitido mesmo com um valor externo acima do limite, e o aviso some abaixo do teto', async () => {
    const { host, editor, onChange } = await setup({ value: 'abcdefgh', maxLength: 4 });
    expect(editor.state.doc.textContent).toBe('abcdefgh');
    act(() => editor.commands.setTextSelection(9));
    typeText(editor, 'x');
    expect(editor.state.doc.textContent).toBe('abcdefgh');
    act(() => { editor.view.dispatch(editor.state.tr.delete(5, 9)); });
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('abcd');
    act(() => { editor.view.dispatch(editor.state.tr.delete(4, 5)); });
    expect(host.querySelector('.composer-tiptap__limit')).toBeNull();
  });
});

describe('F-1170: colar só texto puro', () => {
  it('HTML externo não entra: vale o text/plain', async () => {
    const { host, surface, editor, onChange } = await setup({ value: '' });
    const event = paste(surface, {
      'text/html': '<h1>Título</h1><a href="https://x.test">link</a><img src=x onerror="alert(1)"><script>bad()</script>',
      'text/plain': 'Título link',
    });
    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc.textContent).toBe('Título link');
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('Título link');
    expect(host.querySelector('h1, a, img, script')).toBeNull();
  });

  it('só HTML, sem texto puro: nada entra e o default fica livre (imagem embutida vai para o anexo do app)', async () => {
    const { surface, editor, onChange } = await setup({ value: 'x' });
    const appPaste = vi.fn((event: Event) => event.defaultPrevented);
    document.addEventListener('paste', appPaste);
    try {
      const event = paste(surface, { 'text/html': '<img src="data:image/png;base64,AAAA">' });
      expect(event.defaultPrevented).toBe(false);
      expect(appPaste).toHaveBeenCalledTimes(1);
      expect(appPaste.mock.results[0]?.value).toBe(false);
    } finally {
      document.removeEventListener('paste', appPaste);
    }
    expect(editor.state.doc.textContent).toBe('x');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('colar só arquivo (print/imagem) não insere nada e não reivindica o default', async () => {
    const { surface, editor, onChange } = await setup({ value: 'x' });
    const event = paste(surface, { Files: '' });
    expect(event.defaultPrevented).toBe(false);
    expect(editor.state.doc.textContent).toBe('x');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('texto colado com várias linhas e CRLF vira parágrafos e o markdown sai igual ao colado', async () => {
    const { surface, editor, onChange } = await setup({ value: '' });
    paste(surface, { 'text/plain': 'linha 1\r\nlinha **2**\r\n\r\nsnake_case `x`' });
    expect(editor.state.doc.childCount).toBe(4);
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('linha 1\nlinha **2**\n\nsnake_case `x`');
  });
});

describe('F-1170: atalhos produzem as marcas do markdown canônico', () => {
  it.each([
    ['b', false, '**palavra**'],
    ['i', false, '*palavra*'],
    ['e', false, '`palavra`'],
    ['s', true, '~~palavra~~'],
  ] as const)('Mod+%s (shift=%s) → %s', async (key, shiftKey, expected) => {
    const { surface, editor, onChange } = await setup({ value: 'palavra' });
    act(() => editor.commands.setTextSelection({ from: 1, to: 8 }));
    // keyCode real do teclado: o keymap do ProseMirror cai nele com Shift.
    keydown(surface, { key: shiftKey ? key.toUpperCase() : key, shiftKey, ...mod }, key.toUpperCase().charCodeAt(0));
    expect(onChange.mock.calls.at(-1)?.[0]).toBe(expected);
  });

  it('marcas fora do markdown canônico (sublinhado, link) não existem no schema', async () => {
    const { editor } = await setup({ value: 'x' });
    expect(Object.keys(editor.schema.marks).sort()).toEqual(['bold', 'code', 'italic', 'strike']);
    expect(Object.keys(editor.schema.nodes).sort()).toEqual(['doc', 'hardBreak', 'paragraph', 'text']);
  });
});

describe('F-1170: ida e volta do markdown sem perder texto', () => {
  const samples = [
    'texto simples',
    'acentuação: ação, maçã, pão, você, à, über, niño',
    'emoji 🚀 e família 👨‍👩‍👧 e bandeira 🇧🇷',
    'snake_case e __dunder__ e _a_',
    'a * b * c e 2*3*4',
    '**negrito** *itálico* ~~tachado~~ `código`',
    'crase solta ` e dupla `` e ```bloco```',
    'linha 1\nlinha 2\n\nlinha 4',
    '\n\ncomeça e termina vazio\n\n',
    String.raw`C:\Users\Alice\repo e \\server\share`,
    String.raw`escape \* literal e \_ e \` e \\`,
    '[origem: missao=m_1 evento=evt_3 seq=3 pane=pane-7]',
    '> citação\n> 18 tests passed',
    '<b>não é html</b> & &amp; "aspas" \'simples\'',
    '   espaços   no meio e nas pontas   ',
    '\ttab\tinterno',
  ];

  it.each(samples)('valor %j monta, edita no fim e volta preservado', async (value) => {
    const { editor, onChange } = await setup({ value });
    // Sem edição o documento reserializa um markdown que se lê igual ao
    // recebido (mesmo texto, mesmas marcas; `__x__` pode virar `**x**`)…
    expect(readAs(tiptapJsonToMarkdown(editor.getJSON()))).toEqual(readAs(value));
    // …e uma edição real no fim não reescreve o resto.
    act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
    typeText(editor, '!');
    const saved = onChange.mock.calls.at(-1)?.[0] as string;
    const fresh = await setup({ value: saved });
    expect(tiptapJsonToMarkdown(fresh.editor.getJSON())).toBe(saved);
    expect(fresh.editor.state.doc.textContent).toBe(editor.state.doc.textContent);
  });

  it.each([
    'a*b', 'a_b', '2 * 3', 'x`y', '**não negrito**', '~~não tachado~~', '`não código`',
    String.raw`barra \ solta`, 'trailing\\', 'ação 🚀 ü',
  ])('texto literal digitado %j sobrevive a salvar e remontar', async (text) => {
    const { editor, onChange } = await setup({ value: '' });
    typeText(editor, text);
    const saved = onChange.mock.calls.at(-1)?.[0] as string;
    const fresh = await setup({ value: saved });
    expect(fresh.editor.state.doc.textContent).toBe(text);
    expect(fresh.editor.state.doc.firstChild!.content.content.every((node) => node.marks.length === 0)).toBe(true);
  });

  it.each([
    '> Implementar interface · evento #3 · Shell\n> 18 tests passed\n[origem: missao=m_1 evento=evt_3 seq=3 pane=pane_7]\n\n',
    'acentuação, emoji 🚀, my_file.ts, 2*3, C:\\Users\\x',
  ])('valor canônico %j passa intacto por uma edição no início', async (value) => {
    const { editor, onChange } = await setup({ value });
    act(() => editor.commands.setTextSelection(1));
    typeText(editor, 'Ok ');
    expect(onChange.mock.calls.at(-1)?.[0]).toBe(`Ok ${value}`);
  });

  it('texto digitado sem marcadores ambíguos sai sem escapes (o que o agente lê é o que foi escrito)', async () => {
    const { editor, onChange } = await setup({ value: '' });
    typeText(editor, 'renomeie my_file_name.ts para snake_case; 2*3 = 6');
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('renomeie my_file_name.ts para snake_case; 2*3 = 6');
  });
});

/** Leitura do markdown: trechos (texto, marcas ordenadas) já coalescidos. */
function readAs(markdown: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const span of parseInlineMarkdown(markdown)) {
    const key = [...span.marks].sort().join(',');
    const last = out.at(-1);
    if (last && last[1] === key) last[0] += span.text;
    else out.push([span.text, key]);
  }
  return out;
}
