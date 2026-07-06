import type { MouseEvent } from 'react';

export function openExternalFromAnchor(
  event: MouseEvent<HTMLAnchorElement>,
  url: string,
): void {
  event.preventDefault();
  void window.nexus.app.openExternal(url);
}
