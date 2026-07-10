/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAxTree, performAxAction } from './ax-tree';

const realDocument = globalThis.document;

afterEach(() => {
  vi.unstubAllGlobals();
  realDocument.body.innerHTML = '';
});

describe('getAxTree', () => {
  it('returns empty tree when document.body is null', () => {
    vi.stubGlobal('document', { body: null });

    const tree = getAxTree();
    expect(tree.tag).toBe('html');
    expect(tree.children).toHaveLength(0);
  });

  it('reads the active renderer DOM into an AX-like tree', () => {
    document.body.innerHTML = `
      <main>
        <button aria-label="Run mission">Start</button>
        <section role="status" aria-live="polite">Ready</section>
      </main>
    `;

    const tree = getAxTree();
    expect(tree.tag).toBe('body');
    expect(tree.children).toHaveLength(1);

    const main = tree.children[0];
    expect(main.tag).toBe('main');
    expect(main.children[0]).toMatchObject({
      tag: 'button',
      role: null,
      aria: { label: 'Run mission' },
      text: 'Start',
    });
    expect(main.children[1]).toMatchObject({
      tag: 'section',
      role: 'status',
      aria: { live: 'polite' },
      text: 'Ready',
    });
  });

  it('skips CSS-hidden and aria-hidden elements', () => {
    document.body.innerHTML = `
      <div>visible</div>
      <div style="display: none">hidden display</div>
      <div aria-hidden="true">hidden aria</div>
    `;

    const tree = getAxTree();
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].text).toBe('visible');
  });

  it('skips script and style tags', () => {
    document.body.innerHTML = `
      <p>text</p>
      <script>window.bad = true</script>
      <style>body { color: red; }</style>
    `;

    const tree = getAxTree();
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].tag).toBe('p');
  });

  it('assigns snapshot-scoped refs and clicks a visible interactive control', () => {
    document.body.innerHTML = '<button aria-label="Start mission">Start</button>';
    const button = document.querySelector('button')!;
    const clicked = vi.fn();
    button.addEventListener('click', clicked);

    const tree = getAxTree();
    const ref = tree.children[0].ref;

    expect(ref).toMatch(/^u\d+e\d+$/);
    expect(performAxAction({ action: 'click', ref: ref! })).toMatchObject({
      ok: true,
      action: 'click',
      ref,
    });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('rejects stale refs after a new accessibility snapshot', () => {
    document.body.innerHTML = '<button>Start</button>';
    const firstRef = getAxTree().children[0].ref!;

    getAxTree();

    expect(performAxAction({ action: 'click', ref: firstRef })).toEqual({
      ok: false,
      action: 'click',
      ref: firstRef,
      error: 'stale_ref',
    });
  });

  it('fills safe text inputs and emits input/change without exposing values', () => {
    document.body.innerHTML = '<input aria-label="Mission name" />';
    const input = document.querySelector('input')!;
    const onInput = vi.fn();
    const onChange = vi.fn();
    input.addEventListener('input', onInput);
    input.addEventListener('change', onChange);
    const ref = getAxTree().children[0].ref!;

    const result = performAxAction({ action: 'fill', ref, text: 'Release 1' });

    expect(result).toMatchObject({ ok: true, action: 'fill', ref });
    expect(result).not.toHaveProperty('text');
    expect(input.value).toBe('Release 1');
    expect(onInput).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('refuses password, file and disabled controls', () => {
    document.body.innerHTML = `
      <input type="password" />
      <input type="file" />
      <button disabled>Delete</button>
    `;
    const tree = getAxTree();

    expect(
      performAxAction({ action: 'fill', ref: tree.children[0].ref!, text: 'secret' }),
    ).toMatchObject({ ok: false, error: 'sensitive_control' });
    expect(
      performAxAction({ action: 'fill', ref: tree.children[1].ref!, text: 'file' }),
    ).toMatchObject({ ok: false, error: 'sensitive_control' });
    expect(
      performAxAction({ action: 'click', ref: tree.children[2].ref! }),
    ).toMatchObject({ ok: false, error: 'disabled_control' });
  });

  it('refuses detached, newly hidden, secret-labelled and payment controls', () => {
    document.body.innerHTML = `
      <button>Temporary</button>
      <input aria-label="Visible for now" />
      <label>API key <input /></label>
      <label for="card-field">Credit card number</label>
      <input id="card-field" />
    `;
    const tree = getAxTree();
    const [button, visibleInput, secretLabel, paymentLabel, paymentInput] =
      tree.children;
    document.querySelector('button')!.remove();
    document.querySelector<HTMLInputElement>('[aria-label="Visible for now"]')!.hidden =
      true;

    expect(
      performAxAction({ action: 'click', ref: button.ref! }),
    ).toMatchObject({ ok: false, error: 'detached_control' });
    expect(
      performAxAction({ action: 'fill', ref: visibleInput.ref!, text: 'hidden' }),
    ).toMatchObject({ ok: false, error: 'hidden_control' });
    expect(
      performAxAction({
        action: 'fill',
        ref: secretLabel.children[0].ref!,
        text: 'secret',
      }),
    ).toMatchObject({ ok: false, error: 'sensitive_control' });
    expect(paymentLabel.tag).toBe('label');
    expect(
      performAxAction({ action: 'fill', ref: paymentInput.ref!, text: '4111' }),
    ).toMatchObject({ ok: false, error: 'sensitive_control' });
  });

  it('selects an existing option but rejects an unknown value', () => {
    document.body.innerHTML = `
      <select aria-label="Model">
        <option value="safe">Safe</option>
        <option value="fast">Fast</option>
      </select>
    `;
    const select = document.querySelector('select')!;
    const ref = getAxTree().children[0].ref!;

    expect(performAxAction({ action: 'select', ref, text: 'fast' })).toMatchObject({
      ok: true,
    });
    expect(select.value).toBe('fast');
    expect(performAxAction({ action: 'select', ref, text: 'missing' })).toMatchObject({
      ok: false,
      error: 'option_not_found',
    });
  });
});
