/**
 * F-1434 — no macOS, os serviços de mídia do Chromium rodam NO browser
 * process em vez de utility processes sandboxados.
 *
 * Campo (13/10/2026, 0.76.244, macOS 27.2): segurar Space para ditar abria
 * `getUserMedia`; o Chromium lançava o Audio Service (e o Video Capture
 * Service, via `enumerateDevices`) em `NexusIDE Helper.app` com seatbelt.
 * Esses helpers morreram no launch (dyld ignition / SIGTRAP no
 * ElectronMain), o renderer crashou (tela preta) e, na segunda tentativa, o
 * processo main abortou (SIGABRT) — ditado derrubava o app inteiro.
 * Evidência: voice.log (`voice.turn.wake` reason=dictation como última
 * linha), crash-reports.json (render-process-gone/exitCode 5) e os .ips de
 * 2026-10-13 14:24 em ~/Library/Logs/DiagnosticReports.
 *
 * Com os serviços in-process nenhum helper é lançado para capturar o
 * microfone: a captura roda no processo principal, que já carrega o
 * entitlement `com.apple.security.device.audio-input`. Os nomes das
 * features foram conferidos no binário empacotado (Chromium 150 do
 * Electron 43.7.4): `AudioServiceOutOfProcess` e
 * `VideoCaptureServiceInBrowserProcess` existem nele.
 *
 * Só macOS: Windows/Linux não têm o launch seatbelt nem o entitlement, e
 * não há evidência de campo contra os serviços out-of-process lá.
 */

/** Features a DESLIGAR (`--disable-features`) para a captura no macOS. */
export function darwinMediaDisabledFeatures(platform: string): string[] {
  return platform === 'darwin' ? ['AudioServiceOutOfProcess'] : [];
}

/** Features a LIGAR (`--enable-features`) para a captura no macOS. */
export function darwinMediaEnabledFeatures(platform: string): string[] {
  return platform === 'darwin'
    ? ['VideoCaptureServiceInBrowserProcess']
    : [];
}
