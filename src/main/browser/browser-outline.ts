import type {
  BrowserElementDescriptor,
  BrowserPageReadResult,
} from '../../shared/browser-automation';

const OUTLINE_MAX_CHARS = 12_000;
const BODY_TEXT_MAX_CHARS = 4_000;
const MAX_HEADING_INDENT = 8;

function elementLine(element: BrowserElementDescriptor): string {
  const bits: string[] = [`[${element.ref}]`, element.role];
  if (element.name) bits.push(`"${element.name}"`);
  if (element.href) bits.push(`→ ${element.href}`);
  const flags: string[] = [];
  if (element.disabled) flags.push('disabled');
  else if (element.editable) flags.push('editable');
  if (element.checked === true) flags.push('checked');
  if (element.invalid) flags.push('invalid');
  if (element.expanded === true) flags.push('expanded');
  if (element.selected === true) flags.push('selected');
  if (flags.length) bits.push(`(${flags.join(', ')})`);
  return bits.join(' ');
}

/**
 * Renders a page read as a compact, LLM-friendly outline. Pure function — the
 * page-side `read` result is already bounded and redacted; this only re-shapes
 * it, capping the body text and the total outline.
 */
export function renderBrowserOutline(
  read: BrowserPageReadResult,
  options: { preserveSelectedText?: boolean } = {},
): string {
  if (options.preserveSelectedText) {
    // Focus already selected bounded source passages. Do not truncate their tail
    // again at the ordinary 4K excerpt limit or let controls displace them.
    const header = `${read.url} · ${read.title}`.slice(0, 1_000);
    const text = read.bodyText.slice(0, 20_000);
    const details = renderBrowserOutline({ ...read, url: '', title: '', bodyText: '' })
      .split('\n').slice(1).join('\n').trim().slice(0, 2_000);
    return `${header}\n\n## texto\n${text}${details ? `\n\n${details}` : ''}`;
  }
  const lines: string[] = [`${read.url} · ${read.title}`];

  if (read.headings.length) {
    lines.push('', '## headings');
    for (const heading of read.headings) {
      const indent = '  '.repeat(
        Math.min(Math.max(heading.level - 1, 0), MAX_HEADING_INDENT),
      );
      lines.push(`${indent}${heading.text}`);
    }
  }

  // Alerts ride before the element list: a long page must not truncate the
  // one line that says the form was refused.
  if (read.alerts.length) {
    lines.push('', '## alertas');
    for (const alert of read.alerts) {
      lines.push(`${alert.ref ? `[${alert.ref}] ` : ''}${alert.role}: ${alert.text}`);
    }
  }

  if (read.elements.length) {
    lines.push('', '## elementos');
    for (const element of read.elements) {
      lines.push(elementLine(element));
    }
  }

  if (read.bodyText) {
    lines.push('', '## texto');
    lines.push(read.bodyText.slice(0, BODY_TEXT_MAX_CHARS));
  }

  const tail = `— ${read.elements.length} elementos, ${read.viewport.pagesBelow} telas abaixo`;
  if (read.viewport.pagesBelow > 0 || read.elements.length > 0) {
    lines.push('', tail);
  }

  return lines.join('\n').slice(0, OUTLINE_MAX_CHARS);
}
