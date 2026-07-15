import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(
  new URL('../styles/base.css', import.meta.url),
  'utf8',
);

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return '';
  const end = css.indexOf('}', start);
  return css.slice(start, end + 1);
}

describe('workspace chrome window drag regions', () => {
  it('keeps the flexible toolbar track draggable', () => {
    expect(rule('.workspace-bar__actions')).toContain(
      '-webkit-app-region: drag',
    );
  });

  it('keeps toolbar zones available for clicks instead of moving the window', () => {
    expect(rule('.workspace-bar__zone')).toContain(
      '-webkit-app-region: no-drag',
    );
  });
});
