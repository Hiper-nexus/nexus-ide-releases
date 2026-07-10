// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  dialogFocusableElements,
  trapDialogTabKey,
} from './settings-dialog-focus';

describe('settings dialog focus management', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="outside">outside</button>
      <div id="dialog">
        <button id="first">first</button>
        <button id="disabled" disabled>disabled</button>
        <input id="last" />
      </div>`;
  });

  it('returns only enabled focusable descendants', () => {
    const dialog = document.querySelector<HTMLElement>('#dialog')!;
    expect(dialogFocusableElements(dialog).map((element) => element.id)).toEqual([
      'first',
      'last',
    ]);
  });

  it('wraps Tab and Shift+Tab inside the dialog', () => {
    const dialog = document.querySelector<HTMLElement>('#dialog')!;
    const first = document.querySelector<HTMLElement>('#first')!;
    const last = document.querySelector<HTMLElement>('#last')!;

    last.focus();
    expect(trapDialogTabKey(dialog, false)).toBe(true);
    expect(document.activeElement).toBe(first);

    first.focus();
    expect(trapDialogTabKey(dialog, true)).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('moves focus back inside when it escaped the modal', () => {
    const dialog = document.querySelector<HTMLElement>('#dialog')!;
    document.querySelector<HTMLElement>('#outside')!.focus();

    expect(trapDialogTabKey(dialog, false)).toBe(true);
    expect(document.activeElement?.id).toBe('first');
  });
});
