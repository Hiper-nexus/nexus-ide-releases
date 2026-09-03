# Frontend extraído — BridgeSpace 3.4.18

Assets embutidos no binário Tauri (`bridgespace-tauri`, Mach-O arm64). O blob usa
**mix de assets comprimidos (brotli) e não-comprimidos** — o tauri-codegen decide por asset.

## Layout

```
assets__<nome-vite>        90 assets com nomes Vite REAIS (canônico para leitura)
manifest.json              mapa path→file+bytes+sha256_12 (90 entradas, 0 divergências)
index.html                 ENTRY REAL do app (stream 014) — refs index-D0sLjlYW.js + index-D74TX2y4.css
auth-success.html          página "You're signed in" (tokens de design capturados aqui)
inventory-brotli.json      metadados dos 59 streams (offset/compLen/decompLen/sha)
_brotli/                   59 streams descomprimidos no nível bruto (procedência)
```

## Verificação de integridade

`manifest.json` foi validado: todos os 90 arquivos batem com o sha256_12 declarado.
Todos os 76 paths `/assets/...` citados no JS estão cobertos; 14 extras vêm da região
não-comprimida do blob (MainApp 1.1MB, DropZoneOverlay, RunTaskModal, etc).

## _brotli/ — o que só existe lá

A extração nomeada cobre os assets Vite; os streams brutos preservam o que não tem
nome Vite ou foi classificado genericamente:

| Stream | Conteúdo |
|--------|----------|
| `014-*.html` | entry real do app (copiado para `index.html`) |
| `020-*.css` | CSS `.sw-root` — design tokens do Shadow-Web (widget embutido) |
| `031-*.txt` | **modelo ONNX** 857KB (protobuf "pytorch 1.12.1, onnx::Flatten") |
| `055-*.txt` | **modelo ONNX** 773KB (magic "nnx") |
| `035-*.txt` | weight blob 825KB |
| `032-038, 056-059` | weight blobs menores |
| resto `.js` | chunks já cobertos pelos nomes Vite (duplicados por sha) |

**Nenhum loader de ONNX/transformers.js foi encontrado no JS** — os modelos são carregados
por código nativo Rust ou via `vendor-*` ainda não identificado. Pendência do dossiê.

## Regeneração

```bash
cd ../scripts
~/.hermes/node/bin/node --max-old-space-size=8192 scan-brotli.mjs   # _brotli, 0.3s, determinístico
~/.hermes/node/bin/node carve-binary.mjs                              # _carved (runs plaintext + magic bytes)
```

`scan-brotli.mjs` só apaga `_brotli/` (rmSync scoped) — seguro re-rodar com os
`assets__*` no lugar. `carve-binary.mjs` grava em `_carved/`.

## Notas de design (auth-success.html)

- Logo 256×256: rect rx=48 #0a0a0a + 4 quadrantes — TL ouro #FFD24A→#F6B000, BR azul
  #3B9BFF→#0060B0, TR/BL quase-preto #1A1A1A→#0E0E0E com stroke rgba(255,255,255,.06)
- Fundo: radial-gradient ouro/azul sobre #0a0a0a + 2 blobs blur(120px) opacity .35
- Card glass: rgba(255,255,255,.04) + border rgba(255,255,255,.06) + radius 20px +
  backdrop-filter blur(24px) + sombra dupla
- Sucesso: #4ade80 + halo pulsante 2s + ring 2.4s
- Spring: cubic-bezier(.34,1.56,.64,1) no scaleIn
- `prefers-reduced-motion` desliga TUDO (bom sinal de acessibilidade)
