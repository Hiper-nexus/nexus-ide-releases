/** @vitest-environment jsdom */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AccessPaneList } from './AccessPaneList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(ui: ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(ui));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const panes = [
  { id: 'a', title: 'Claude · Missão Travoue parou' },
  { id: 'b', title: 'GPT · task-24202d3f595f1f45…' },
];

it('sem terminais não renderiza nada (nem um título com lista vazia)', async () => {
  const el = await render(<AccessPaneList panes={[]} states={new Map()} onClose={vi.fn()} />);
  expect(el.innerHTML).toBe('');
});

it('conta os terminais e escreve o estado de cada um em texto', async () => {
  const el = await render(<AccessPaneList panes={panes} states={new Map([['a', 'hibernated'], ['b', 'busy']])} onClose={vi.fn()} />);
  expect(el.querySelector('h2')!.textContent).toBe('Seus terminais');
  expect(el.textContent).toContain('2 preservados');
  const rows = [...el.querySelectorAll('li')];
  expect(rows[0].textContent).toContain('Em pausa');
  expect(rows[1].textContent).toContain('Trabalhando');
});

it('um terminal usa o singular', async () => {
  const el = await render(<AccessPaneList panes={[panes[0]]} states={new Map()} onClose={vi.fn()} />);
  expect(el.textContent).toContain('1 preservado');
  expect(el.textContent).not.toContain('1 preservados');
});

it('estado desconhecido cai em "Preservado" em vez de vazio ou undefined', async () => {
  const el = await render(<AccessPaneList panes={[panes[0]]} states={new Map()} onClose={vi.fn()} />);
  expect(el.querySelector('li')!.textContent).toContain('Preservado');
  expect(el.textContent).not.toContain('undefined');
});

it('o botão diz "Fechar" mas se nomeia por inteiro para leitor de tela, e fecha o pane certo', async () => {
  const onClose = vi.fn();
  const el = await render(<AccessPaneList panes={panes} states={new Map()} onClose={onClose} />);
  const second = el.querySelectorAll('button')[1];
  expect(second.textContent).toBe('Fechar');
  expect(second.getAttribute('aria-label')).toBe('Fechar GPT · task-24202d3f595f1f45…');
  await act(async () => second.click());
  expect(onClose).toHaveBeenCalledWith('b');
});

it('título longo mantém o texto completo no atributo title (a tela só o trunca)', async () => {
  const el = await render(<AccessPaneList panes={[panes[1]]} states={new Map()} onClose={vi.fn()} />);
  expect(el.querySelector('.access-pane__title')!.getAttribute('title')).toBe(panes[1].title);
});

it('o ponto de estado é decorativo (o texto já carrega o significado)', async () => {
  const el = await render(<AccessPaneList panes={panes} states={new Map([['a', 'idle']])} onClose={vi.fn()} />);
  for (const dot of el.querySelectorAll('.access-pane__dot')) expect(dot.getAttribute('aria-hidden')).toBe('true');
});
