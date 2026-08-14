import { createHash } from 'node:crypto';

/** Apelido que o agente pode ver: sem @, sem IP, sem porta. */
const ALIAS_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,62}$/;
const IPV4_RE = /(?:\d{1,3}\.){3}\d{1,3}/;
const IPV6_RE = /(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/i;
const USER_AT_RE = /@/;

export function looksLikeIpv4(value: string): boolean {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

export function looksLikeIpv6(value: string): boolean {
  const clean = value.trim();
  if (!clean.includes(':')) return false;
  return IPV6_RE.test(clean) && !ALIAS_RE.test(clean);
}

export function looksLikeEndpoint(value: string): boolean {
  const clean = value.trim();
  if (!clean) return false;
  if (USER_AT_RE.test(clean)) return true;
  if (looksLikeIpv4(clean) || looksLikeIpv6(clean)) return true;
  if (/:\d{2,5}$/.test(clean)) return true;
  return false;
}

export function isSshAlias(value: string): boolean {
  const clean = value.trim();
  if (!ALIAS_RE.test(clean)) return false;
  if (clean.startsWith('-')) return false;
  if (looksLikeIpv4(clean) || looksLikeIpv6(clean)) return false;
  return true;
}

export function requireSshAlias(value: string): string {
  const clean = value.trim();
  if (!isSshAlias(clean)) {
    throw new Error('use a registered ssh alias');
  }
  return clean;
}

export function hashEndpoint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** Remove IPs/hostnames de texto que o agente, o transcript ou logs INFO possam ver. */
export function redactSshEndpoint(
  text: string,
  extra: readonly string[] = [],
): string {
  let out = text;
  out = out.replace(new RegExp(IPV4_RE.source, 'g'), '[redacted-host]');
  out = out.replace(new RegExp(IPV6_RE.source, 'gi'), '[redacted-host]');
  for (const host of extra) {
    const needle = host.trim();
    if (needle.length < 3) continue;
    out = out.split(needle).join('[redacted-host]');
  }
  return out;
}

export type SshBootstrapErrorKind =
  | 'auth'
  | 'timeout'
  | 'host_key'
  | 'unreachable'
  | 'invalid'
  | 'unknown';

export function classifySshBootstrapError(
  message: string,
): SshBootstrapErrorKind {
  const text = message.toLowerCase();
  if (
    /permission denied|authentication failed|senha recusada|too many authentication|denied \(publickey|denied \(password/.test(
      text,
    )
  ) {
    return 'auth';
  }
  if (/timed out|connection timed out|operation timed out|connecttimeout/.test(text)) {
    return 'timeout';
  }
  if (
    /host key verification failed|remote host identification has changed|known_hosts|warning: remote host identification/.test(
      text,
    )
  ) {
    return 'host_key';
  }
  if (
    /could not resolve|name or service not known|nodename nor servname|no route to host|connection refused|network is unreachable/.test(
      text,
    )
  ) {
    return 'unreachable';
  }
  if (/invalid|apelido|alias/.test(text)) return 'invalid';
  return 'unknown';
}

export function sshBootstrapErrorMessage(kind: SshBootstrapErrorKind): string {
  switch (kind) {
    case 'auth':
      return 'Autenticação recusada. Confira usuário e senha — a senha não foi guardada.';
    case 'timeout':
      return 'Tempo esgotado ao alcançar o servidor.';
    case 'host_key':
      return 'A chave de host do servidor não confere (possível troca de máquina ou MITM).';
    case 'unreachable':
      return 'Servidor inacessível. Confira o endereço e a rede.';
    case 'invalid':
      return 'Apelido ou dados de conexão inválidos.';
    default:
      return 'Falha ao conectar. O servidor não foi marcado como conectado.';
  }
}
