// QR do desktop Nexus (F-994): `https://<host>[:porta]/#code=XXXXXXXX`, gerado em
// src/renderer/components/settings/LocalPhoneBridgeCard.tsx. TS puro.
//
// Confiança TLS: o WebSocket do React Native só aceita certificado que o sistema
// confia e não expõe a cadeia para fixar impressão digital em JS. A bridge na LAN
// usa certificado autoassinado (SAN = IPs da máquina), então um QR com IP nunca
// conectaria — e aceitar sem verificar seria MITM aberto. O caminho suportado é o
// Tailscale Serve (`https://<máquina>.<tailnet>.ts.net`, certificado público).

import { nexusVisualHarnessAllowsHost } from './nexus-bridge-visual-harness'

export type NexusBridgePairingTarget = {
  readonly kind: 'nexus-bridge'
  /** wss://host[:porta] — o mesmo origin da página, como o PWA faz. */
  readonly endpoint: string
  /** https://host[:porta] — identifica o desktop para não duplicar o host. */
  readonly origin: string
  readonly host: string
  readonly code: string
}

export type NexusBridgePairingParse =
  | NexusBridgePairingTarget
  | { readonly kind: 'error'; readonly message: string }

// Alfabeto e tamanho de src/main/remote/remote-bridge.ts (PAIRING_ALPHABET/PAIRING_LEN).
const PAIRING_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/

export const NEXUS_SELF_SIGNED_MESSAGE =
  'Este QR aponta para a bridge na rede local, que usa certificado autoassinado — o app não ' +
  'conecta sem HTTPS válido. No desktop (Configurações › Celular na rede local), ligue ' +
  '"Publicar no tailnet (HTTPS)", inicie a bridge e escaneie o QR novo ' +
  '(https://<máquina>.<tailnet>.ts.net). O celular precisa estar no mesmo tailnet.'

export const NEXUS_EXPIRED_CODE_MESSAGE =
  'O QR não traz um código de pareamento válido (expirou ou já foi usado). No desktop, clique em ' +
  '"Girar código de pareamento" e escaneie de novo.'

/** null = não é um QR do Nexus (deixe o parser do Orca tentar). */
export function parseNexusBridgePairingUrl(input: string): NexusBridgePairingParse | null {
  const trimmed = input.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    return null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  const code = readCode(url)
  if (code === null) {
    return null
  }
  if (url.protocol !== 'https:') {
    return { kind: 'error', message: 'A bridge do Nexus só fala HTTPS; este QR usa http://.' }
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
    return { kind: 'error', message: 'Endereço da bridge do Nexus inválido neste QR.' }
  }
  if (!PAIRING_CODE_PATTERN.test(code)) {
    return { kind: 'error', message: NEXUS_EXPIRED_CODE_MESSAGE }
  }
  const host = url.hostname.toLowerCase()
  // F-1035: a exceção do harness visual só existe no alvo web com flag de build.
  if (isLoopbackOrIpLiteral(host) && !nexusVisualHarnessAllowsHost(host)) {
    return { kind: 'error', message: NEXUS_SELF_SIGNED_MESSAGE }
  }
  return {
    kind: 'nexus-bridge',
    endpoint: `wss://${url.host}`,
    origin: `https://${url.host}`,
    host,
    code
  }
}

function readCode(url: URL): string | null {
  // O desktop põe o código no fragmento (nunca chega a log de servidor); aceite ?code= também.
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  const raw = fragment.get('code') ?? url.searchParams.get('code')
  return raw === null ? null : raw.trim().toUpperCase()
}

function isLoopbackOrIpLiteral(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('[') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
  )
}
