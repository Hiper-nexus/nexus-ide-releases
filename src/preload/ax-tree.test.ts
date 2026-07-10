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

  it('refuses password and file as non-targets and blocks disabled controls', () => {
    document.body.innerHTML = `
      <input type="password" />
      <input type="file" />
      <button disabled>Delete</button>
    `;
    const tree = getAxTree();

    expect(tree.children[0].ref).toBeUndefined();
    expect(tree.children[1].ref).toBeUndefined();
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
    // Sensitive controls are never action targets (no ref).
    expect(secretLabel.children[0]?.ref).toBeUndefined();
    expect(paymentLabel.tag).toBe('label');
    expect(paymentInput.ref).toBeUndefined();
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

  it('never exposes password field values and never assigns action refs', () => {
    const secret = 'SuperSecretPassword!99';
    document.body.innerHTML = `
      <label for="pwd">Password</label>
      <input id="pwd" type="password" value="${secret}" />
    `;
    const tree = getAxTree();
    const serialized = JSON.stringify(tree);
    const passwordInput = findByTag(tree, 'input');

    expect(serialized).not.toContain(secret);
    expect(passwordInput).toBeDefined();
    expect(passwordInput?.ref).toBeUndefined();
    expect(passwordInput?.text).toBeNull();
    expect(passwordInput?.aria.valuetext).toBeUndefined();
  });

  it('omits values and action refs for text inputs labelled as API key', () => {
    const secret = 'sk-testleakvalueabcdef1234567890';
    document.body.innerHTML = `
      <label>API key <input type="text" value="${secret}" /></label>
    `;
    const tree = getAxTree();
    const input = findByTag(tree, 'input');
    const serialized = JSON.stringify(tree);

    expect(serialized).not.toContain(secret);
    expect(input?.ref).toBeUndefined();
    expect(input?.text).toBeNull();
  });

  it('detects sensitivity via label for, aria-labelledby, name, id, placeholder and autocomplete', () => {
    document.body.innerHTML = `
      <label for="tok">Access token</label>
      <input id="tok" name="access_token" value="tok-value-must-not-leak" />
      <span id="lbl-secret">Private secret</span>
      <input aria-labelledby="lbl-secret" value="aria-labelled-secret" />
      <input id="api_key_field" value="id-secret-value" />
      <input name="user_password" value="name-secret-value" />
      <input placeholder="Enter API key" value="ph-secret-value" />
      <input autocomplete="current-password" value="ac-secret-value" />
      <input type="text" aria-label="Mission title" value="benign-visible" />
    `;
    const tree = getAxTree();
    const serialized = JSON.stringify(tree);
    const inputs = collectByTag(tree, 'input');

    for (const leak of [
      'tok-value-must-not-leak',
      'aria-labelled-secret',
      'id-secret-value',
      'name-secret-value',
      'ph-secret-value',
      'ac-secret-value',
    ]) {
      expect(serialized).not.toContain(leak);
    }

    const sensitive = inputs.filter((node) => node.aria.label !== 'Mission title');
    // aria-label lands on aria.label; mission title is the only safe control.
    const safe = inputs.find((node) => node.aria.label === 'Mission title');
    expect(safe?.ref).toMatch(/^u\d+e\d+$/);
    for (const node of sensitive) {
      expect(node.ref).toBeUndefined();
      expect(node.text).toBeNull();
    }
  });

  it('never exposes textarea or select values in the AX snapshot', () => {
    document.body.innerHTML = `
      <textarea aria-label="Notes">typed-secret-in-textarea</textarea>
      <select aria-label="Region">
        <option value="us-east" selected>US East</option>
      </select>
    `;
    const tree = getAxTree();
    const serialized = JSON.stringify(tree);
    const textarea = findByTag(tree, 'textarea');
    const select = findByTag(tree, 'select');

    expect(serialized).not.toContain('typed-secret-in-textarea');
    expect(serialized).not.toContain('us-east');
    expect(textarea?.text).toBeNull();
    // Option labels may still appear as children; the control value must not.
    expect(select?.aria.valuetext).toBeUndefined();
  });

  it('preserves nested semantic labels without aggregating form values', () => {
    document.body.innerHTML = `
      <button><span>Run nested mission</span></button>
      <h1><span>Nested heading</span></h1>
      <main><textarea>must-not-reach-main</textarea></main>
    `;
    const tree = getAxTree();
    const button = findByTag(tree, 'button');
    const heading = findByTag(tree, 'h1');
    const main = findByTag(tree, 'main');

    expect(button?.text).toBe('Run nested mission');
    expect(heading?.text).toBe('Nested heading');
    expect(main?.text).toBeNull();
    expect(JSON.stringify(tree)).not.toContain('must-not-reach-main');
  });

  it('keeps depth and node caps fail-closed on huge trees', () => {
    const depth = 14;
    let html = '';
    for (let i = 0; i < depth; i += 1) html += `<div data-d="${i}">`;
    html += '<button>Deep leaf</button>';
    for (let i = 0; i < depth; i += 1) html += '</div>';
    document.body.innerHTML = html;

    const tree = getAxTree();
    expect(maxDepth(tree)).toBeLessThanOrEqual(10);
  });
});

type AxLike = {
  tag: string;
  text: string | null;
  ref?: string;
  aria: Record<string, string>;
  children: AxLike[];
};

function findByTag(node: AxLike, tag: string): AxLike | undefined {
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const found = findByTag(child, tag);
    if (found) return found;
  }
  return undefined;
}

function collectByTag(node: AxLike, tag: string, out: AxLike[] = []): AxLike[] {
  if (node.tag === tag) out.push(node);
  for (const child of node.children) {
    collectByTag(child, tag, out);
  }
  return out;
}

function maxDepth(node: { children: unknown[] }, depth = 0): number {
  if (!node.children.length) return depth;
  return Math.max(
    ...node.children.map((child) => maxDepth(child as { children: unknown[] }, depth + 1)),
  );
}
