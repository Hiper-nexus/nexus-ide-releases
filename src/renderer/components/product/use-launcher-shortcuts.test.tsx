/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useLauncherShortcuts,
  type LauncherShortcutActions,
} from './use-launcher-shortcuts';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function render(node: ReactNode): Root {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function actions(): LauncherShortcutActions {
  return {
    pane: vi.fn(),
    mission: vi.fn(),
    workspace: vi.fn(),
    shell: vi.fn(),
    tasks: vi.fn(),
    memory: vi.fn(),
  };
}

function keydown(key: string, repeat: boolean): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      repeat,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('launcher shortcuts', () => {
  it('treats a repeated number key as one activation', () => {
    const run = actions();
    function Probe() {
      useLauncherShortcuts(true, run);
      return null;
    }
    render(<Probe />);
    act(() => {
      keydown('4', false);
      keydown('4', true);
      keydown('4', true);
      keydown('3', false);
      keydown('3', true);
    });
    expect(run.shell).toHaveBeenCalledTimes(1);
    expect(run.workspace).toHaveBeenCalledTimes(1);
    expect(run.pane).not.toHaveBeenCalled();
  });
});

describe('F-1086: only active visible modal owns number keys',()=>{
  function Probe({children}:{children?:ReactNode}){const run=active;useLauncherShortcuts(true,run);return <>{children}</>;}
  let active:LauncherShortcutActions;
  it('blocks an active modal and resumes immediately after closing it',()=>{
    active=actions();const modalRoot=render(<Probe><div role="dialog" aria-modal="true"><button>Confirmar</button></div></Probe>);
    act(()=>keydown('4',false));expect(active.shell).not.toHaveBeenCalled();
    act(()=>modalRoot.render(<Probe/>));act(()=>keydown('4',false));expect(active.shell).toHaveBeenCalledTimes(1);
  });
  it.each(['hidden','aria-hidden','inert','display','visibility','ancestor'] as const)('allows shortcuts past %s inactive modal',kind=>{
    active=actions();render(<Probe><section><div role="dialog" aria-modal="true">Inactive</div></section></Probe>);
    const dialog=document.querySelector<HTMLElement>('[aria-modal]')!;
    if(kind==='hidden')dialog.hidden=true;
    else if(kind==='aria-hidden')dialog.setAttribute('aria-hidden','true');
    else if(kind==='inert')dialog.setAttribute('inert','');
    else if(kind==='display')dialog.style.display='none';
    else if(kind==='visibility')dialog.style.visibility='hidden';
    else dialog.parentElement!.setAttribute('aria-hidden','true');
    act(()=>keydown('4',false));expect(active.shell).toHaveBeenCalledTimes(1);
  });
  it('does not infer modality from a visible nonmodal dialog',()=>{
    active=actions();render(<Probe><div role="dialog">History</div></Probe>);
    act(()=>keydown('4',false));expect(active.shell).toHaveBeenCalledTimes(1);
  });
  it('keeps consumed/composing keys with their current input owner',()=>{
    active=actions();render(<Probe/>);
    const consumed=new KeyboardEvent('keydown',{key:'4',bubbles:true,cancelable:true});consumed.preventDefault();
    act(()=>{window.dispatchEvent(consumed);window.dispatchEvent(new KeyboardEvent('keydown',{key:'4',isComposing:true,bubbles:true,cancelable:true}));});
    expect(active.shell).not.toHaveBeenCalled();
  });
});
