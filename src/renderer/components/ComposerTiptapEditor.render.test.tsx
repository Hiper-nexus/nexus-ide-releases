/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerTiptapEditor } from './ComposerTiptapEditor';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const geometry = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  // jsdom has no layout; keep the real Tiptap/ProseMirror editor and only supply geometry.
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
async function setup(value: string, editable = true) {
  const onChange = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(<ComposerTiptapEditor value={value} editable={editable} onChange={onChange} />); });
  const surface = host.querySelector<HTMLElement & { editor: Editor }>('[role="textbox"]');
  if (!surface?.editor) throw new Error('Real Tiptap editor did not mount');
  return { root, host, surface, editor: surface.editor, onChange };
}
function enter(surface: HTMLElement, shiftKey = false) {
  surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, shiftKey, bubbles: true, cancelable: true }));
}

describe('ComposerTiptapEditor actual rendered document', () => {
  it('F-1067: initial multiline content is represented by paragraphs and retains marks', async () => {
    const { editor, surface } = await setup('one\n\n**two**');
    expect(editor.getJSON().content?.map((node) => node.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(surface.querySelector('strong')?.textContent).toBe('two');
    expect(editor.getJSON().content?.[1]?.content ?? []).toEqual([]);
  });
  it('F-1067: Enter and an empty paragraph survive an actual editor update', async () => {
    const { editor, surface, onChange } = await setup('one');
    act(() => { editor.commands.setTextSelection(4); surface.focus(); enter(surface); enter(surface); editor.view.dispatch(editor.state.tr.insertText('two')); });
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('one\n\ntwo');
  });
  it('F-1067: Shift-Enter survives as a newline rather than joining words', async () => {
    const { editor, surface, onChange } = await setup('one');
    act(() => { editor.commands.setTextSelection(4); surface.focus(); enter(surface, true); editor.view.dispatch(editor.state.tr.insertText('two')); });
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('one\ntwo');
  });
  it('F-1067: an input update preserves existing bold italic strike and code', async () => {
    const { editor, onChange } = await setup('**bold** *ital* ~~strike~~ `code`');
    act(() => editor.view.dispatch(editor.state.tr.insertText('!')));
    const value = onChange.mock.calls.at(-1)?.[0] as string;
    expect(value).toBe('**!bold** *ital* ~~strike~~ `code`');
  });
  it('F-1067: keyboard click toggles selected text and the accessible pressed state', async () => {
    const { host, editor, onChange } = await setup('word');
    const bold = host.querySelector<HTMLButtonElement>('[aria-label="Negrito"]')!;
    act(() => { editor.commands.setTextSelection({ from: 1, to: 5 }); bold.focus(); bold.click(); });
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('**word**');
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    act(() => bold.click());
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('word');
    expect(bold.getAttribute('aria-pressed')).toBe('false');
  });
  it('F-1067: readonly mode disables formatting and never emits an edit from its toolbar', async () => {
    const { host, surface, editor, onChange } = await setup('word', false);
    const bold = host.querySelector<HTMLButtonElement>('[aria-label="Negrito"]')!;
    expect(surface.getAttribute('contenteditable')).toBe('false');
    expect(bold.disabled).toBe(true);
    act(() => { editor.commands.setTextSelection({ from: 1, to: 5 }); bold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); bold.click(); });
    expect(onChange).not.toHaveBeenCalled();
    expect(surface.textContent).toBe('word');
  });
  it('F-1067: external value replaces a stale draft without emitting a user edit or replacing the editor', async () => {
    const { root, host, editor, onChange } = await setup('one');
    act(() => editor.view.dispatch(editor.state.tr.insertText('draft')));
    const calls = onChange.mock.calls.length;
    await act(async () => root.render(<ComposerTiptapEditor value={'reset\n**fresh**'} onChange={onChange} />));
    expect(Array.from({ length: editor.state.doc.childCount }, (_, index) => editor.state.doc.child(index).textContent)).toEqual(['reset', 'fresh']);
    expect(host.querySelector('strong')?.textContent).toBe('fresh');
    expect(onChange).toHaveBeenCalledTimes(calls);
    expect((host.querySelector('[role="textbox"]') as HTMLElement & { editor: Editor }).editor).toBe(editor);
  });
  it('F-1067: controlled echo keeps the selection, and authoritative editability changes are silent', async () => {
    const { root, host, editor, onChange } = await setup('word');
    act(() => { editor.commands.setTextSelection({ from: 1, to: 5 }); host.querySelector<HTMLButtonElement>('[aria-label="Negrito"]')!.click(); });
    const value = onChange.mock.calls.at(-1)?.[0] as string;
    const documentBeforeEcho = editor.state.doc;
    const selectionBeforeEcho = editor.state.selection.toJSON();
    await act(async () => root.render(<ComposerTiptapEditor value={value} onChange={onChange} />));
    expect(editor.state.doc).toBe(documentBeforeEcho);
    expect(editor.state.selection.toJSON()).toEqual(selectionBeforeEcho);
    const calls = onChange.mock.calls.length;
    await act(async () => root.render(<ComposerTiptapEditor value={value} editable={false} onChange={onChange} />));
    expect(editor.isEditable).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    await act(async () => root.render(<ComposerTiptapEditor value={value} editable onChange={onChange} />));
    expect(editor.isEditable).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(calls);
  });
  it('F-1067: formatting after a foreign DOM selection modifies only this editor', async () => {
    const { host, editor, onChange } = await setup('word');
    const foreign = document.createElement('p'); foreign.textContent = 'outside'; document.body.appendChild(foreign);
    act(() => editor.commands.setTextSelection({ from: 1, to: 5 }));
    const range = document.createRange(); range.selectNodeContents(foreign);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Negrito"]')!.click());
    expect(foreign.textContent).toBe('outside');
    expect(foreign.querySelector('strong')).toBeNull();
    expect(onChange.mock.calls.at(-1)?.[0]).toBe('**word**');
  });

});

describe('F-1079: real editor persistence of paths and literal delimiter text', () => {
  const literals = ['x`y', 'x``y', '`edge', 'edge`', '``runs``', ' x ', '   ', 'x*y', 'x**y', 'x~~y', String.raw`C:\Users\Alice\repo`, String.raw`\\server\share\folder`, String.raw`\n\d+\s`, String.raw`{"path":"C:\\Users"}`, 'trailing\\', 'repeated\\\\slashes'];
  for (const mark of ['Negrito', 'Código inline'] as const) {
    it.each(literals)(`${mark}: format, save and fresh mount preserve %s`, async (text) => {
      const {host,editor,onChange} = await setup('');
      act(() => editor.view.dispatch(editor.state.tr.insertText(text)));
      expect(editor.state.doc.textContent).toBe(text);
      act(() => { editor.commands.setTextSelection({from:1,to:editor.state.doc.content.size-1});host.querySelector<HTMLButtonElement>(`[aria-label="${mark}"]`)!.click(); });
      const saved = onChange.mock.calls.at(-1)?.[0] as string;
      const fresh = await setup(saved);
      expect(fresh.editor.state.doc.textContent).toBe(text);
      if (text.trim()) expect(fresh.editor.state.doc.child(0).content.content.some(node=>node.marks.some(m=>m.type.name===(mark==='Negrito'?'bold':'code')))).toBe(true);
    });
  }
  it('external Windows/UNC value and subsequent actual update retain all path separators', async () => {
    const {root,editor,onChange}=await setup('old');
    const value=String.raw`C:\Users\Alice`+'\n'+String.raw`\\server\share`;
    await act(async()=>root.render(<ComposerTiptapEditor value={value} onChange={onChange}/>));
    expect(Array.from({length:editor.state.doc.childCount},(_,i)=>editor.state.doc.child(i).textContent)).toEqual(value.split('\n'));
    act(()=>editor.view.dispatch(editor.state.tr.insertText('!')));
    const saved=onChange.mock.calls.at(-1)?.[0] as string;
    const fresh=await setup(saved);
    expect(fresh.editor.state.doc.child(1).textContent).toContain(String.raw`\\server\share`);
  });
});

it.each(['trailing\\','trailing\\\\',String.raw`\\server\share`,String.raw`x\*y`])('F-1079: actual unmarked update/save/fresh mount preserves %s',async(text)=>{
  const {editor,onChange}=await setup('');
  act(()=>editor.view.dispatch(editor.state.tr.insertText(text)));
  const saved=onChange.mock.calls.at(-1)?.[0] as string;
  const fresh=await setup(saved);
  expect(fresh.editor.state.doc.textContent).toBe(text);
});

it.each(['Negrito','Código inline'] as const)('F-1079: actual partial %s formatting preserves adjacent unmarked slash and text marks on remount',async(mark)=>{
  const {host,editor,onChange}=await setup('a\\b');
  act(()=>{editor.commands.setTextSelection({from:3,to:4});host.querySelector<HTMLButtonElement>(`[aria-label="${mark}"]`)!.click();});
  const saved=onChange.mock.calls.at(-1)?.[0] as string;
  const fresh=await setup(saved);
  expect(fresh.editor.state.doc.textContent).toBe('a\\b');
  expect(fresh.editor.getJSON().content?.[0]?.content).toEqual([
    {type:'text',text:'a\\'},
    {type:'text',text:'b',marks:[{type:mark==='Negrito'?'bold':'code'}]},
  ]);
});
