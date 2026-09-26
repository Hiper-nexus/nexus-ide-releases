/** Address-bar intent only. Main still validates every navigation and socket. */
export function browserAddressInput(raw: string): string {
  const input = raw.trim();
  if (!input || input === 'about:blank') return input;
  if (/^https?:\/\//i.test(input)) return input;
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input) && !/\s/.test(input)) {
    return `http://${input}`;
  }
  // A host:port is an address, not a custom URL scheme.
  if (/^[^\s/:]+\.([^\s/:]+)(?::\d+)?(?:[/?#].*)?$/.test(input)) {
    return `https://${input}`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    throw new Error('Use um endereço http ou https, ou digite uma busca.');
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}
