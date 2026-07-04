# Publicar uma nova versão (automático via GitHub Actions)

O workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml)
builda em **Node 22 LTS**, **assina** com Developer ID, **notariza** na Apple e
**publica o Release** com o `.dmg` (instalador) e o `.zip` (payload do
auto-update Squirrel.Mac) — tudo ao dar push numa tag `v*`.

## Cortar uma release (o dia a dia)

```bash
npm version patch      # 0.1.4 -> 0.1.5, cria commit + tag v0.1.5
git push --follow-tags # dispara o CI
```

Pronto. Em alguns minutos o Release aparece em **Releases** com o `.dmg`
assinado e notarizado. Os usuários que já têm o app recebem a atualização
sozinhos (auto-update). `npm version minor` / `major` para saltos maiores.

## Setup único dos GitHub Secrets

O CI precisa de 6 secrets no repositório
(**Settings → Secrets and variables → Actions**). Já foram configurados; use
esta seção só se precisar rotacionar.

| Secret | O que é |
| --- | --- |
| `MACOS_CERTIFICATE` | O certificado **Developer ID Application** + chave privada, exportado como `.p12` e codificado em base64. |
| `MACOS_CERTIFICATE_PASSWORD` | A senha definida ao exportar o `.p12`. |
| `KEYCHAIN_PASSWORD` | Uma senha qualquer para a keychain temporária do CI. |
| `APPLE_ID` | Apple ID da conta de desenvolvedor. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-Specific Password (appleid.apple.com). |
| `APPLE_TEAM_ID` | Team ID (10 caracteres). |

### Como exportar o `.p12` (para `MACOS_CERTIFICATE`)

1. **Acesso às Chaves** → categoria **Certificados** → botão direito em
   **"Developer ID Application: … (TEAMID)"** → **Exportar…**
2. Salve como `devid.p12` e defina uma senha (vira `MACOS_CERTIFICATE_PASSWORD`).
3. Gere o base64 do arquivo:
   ```bash
   base64 -i devid.p12 | pbcopy   # conteúdo vai para o clipboard
   ```
   Cole como valor do secret `MACOS_CERTIFICATE`.

> O certificado Developer ID vale ~5 anos; a App-Specific Password até ser
> revogada. Rotacione os secrets se qualquer um mudar.

## Build local (fallback, sem CI)

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # Node 22 LTS
export APPLE_ID="…"; export APPLE_APP_SPECIFIC_PASSWORD="…"; export APPLE_TEAM_ID="…"
npm run make
```

Detalhes de assinatura/notarização em [`build/notarize.md`](../build/notarize.md).
