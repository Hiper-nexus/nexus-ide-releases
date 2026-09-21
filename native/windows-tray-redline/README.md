# Nexus Redline (Windows) — companheiro de bandeja

Paridade Windows do app de menu bar do macOS (`native/menubar-redline/`):
lê `%USERPROFILE%\.nexus\redline-last-good.json` (escrito pelo quota-service
do Nexus) e mostra na bandeja a folga de cada conta de IA — painel escuro
400×≤600 com barras 5h/semana, cores de urgência e cronômetro até o reset.

## Arquivos

| Arquivo | Papel |
|---|---|
| `redline-model.h/.cc` | Parser JSON mínimo + modelo + formatação. Sem `<windows.h>`: a mesma lógica que a bandeja desenha. |
| `redline-tray.cc` | Win32 puro (bandeja, popup, autostart HKCU, watch do snapshot). GDI/GDI+ do SO, sem terceiros. |
| `redline.manifest` | Manifesto do exe (asInvoker, UTF-8, per-monitor DPI). |
| `README.md` | Este arquivo. |

O build (`scripts/build-windows-tray.mjs`) gera `redline-version.rc`
(VERSIONINFO carimbado com `package.json` + ícone) e compila com o MSVC:

```
native/windows-tray-redline/*.cc → resources/native/win32/nexus-redline/NexusRedline.exe
```

O bundle comita `NexusRedline.exe` + `provider-logos/` (PNGs e `manifest.json`
copiados de `native/menubar-redline/assets/provider-logos/` + `NOTICE.md` —
as marcas não viajam para outro bundle sem ele), igual ao `.app` do Mac que
é "carimbado" por versão.

## Doutrina (igual ao Mac)

- Read-only sobre os dados: nunca lê credencial, nunca renova token, nunca
  fala com provider ou rede.
- Único efeito colateral: `redline-refresh.request` ("Atualizar agora") e a
  própria instalação/autostart, ambos por gesto explícito do usuário.
- Instalação por usuário (`%LocalAppData%\NexusRedline`, autostart via
  `HKCU\...\Run`) — sem admin, combinando com o Squirrel per-user.
- Uma instância (mutex nomeado). Abrir o exe de novo não sai calado:
  pede o painel à instância que já está na bandeja. `nexus://quota` abre
  as cotas no Nexus (protocolo já registrado pelo app nas três plataformas
  via deep-link).

## Self-test

`NexusRedline.exe --self-test` roda parser + formatação + roundtrip no disco
e imprime `Redline Windows checks passed` (espelha `main.test.swift` do Mac).
O teste vitest (`scripts/build-windows-tray.test.mjs`) compila o binário real
e executa esse modo com um snapshot fixture.

- `--paint-check <snapshot> <bmp1> [bmp2]`: desenha o painel de verdade num
  DIB em memória e salva BMPs (o 2º com scroll). O teste confere superfície
  escura, conteúdo e pixels movidos pelo scroll.
- `--first-run`: balão apontando o overflow (^) — o instalador passa na
  primeira execução pós-instalação, porque o Windows esconde ícones novos.
- `--toggle-panel`: abre o painel pelo `showPanel()` real e sai em ~3s;
  exit 0 prova que a janela abriu (seam para o teste do clique).
