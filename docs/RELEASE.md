# Publicar uma nova versão (automático via GitHub Actions)

O workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml)
builda em **Node 22 LTS**, **assina** com Developer ID, **notariza** na Apple e
**publica o Release** com DMG + ZIP Squirrel para **Apple Silicon e Intel**.
Os dois builds passam por verificação independente antes de o job final criar a
release — tudo ao dar push numa tag `v*`.

## Cortar uma release (o dia a dia)

```bash
npm version patch      # 0.1.4 -> 0.1.5, cria commit + tag v0.1.5
git push --follow-tags # dispara o CI
```

Pronto. Em alguns minutos o Release aparece em **Releases** com os DMGs e ZIPs
assinados e notarizados. `npm version minor` / `major` para saltos maiores.

> Auto-update de consumidor ainda exige um feed HTTPS operacional em
> `NEXUS_UPDATE_FEED`. Enquanto o repositório for privado e esse feed não
> estiver provisionado, o fallback via `gh` só funciona em máquinas que já têm
> GitHub CLI autenticado; ele não substitui um canal público de atualização.

## Setup único dos GitHub Secrets

O CI precisa de 6 secrets no repositório
(**Settings → Secrets and variables → Actions**). Não trate os valores como
válidos só porque existem: antes de cortar uma tag, rode uma release de teste ou
valide `notarytool history`; uma credencial Apple expirada/inválida bloqueia a
notarização e não deve ser contornada com assinatura ad-hoc.

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

O perfil de notarização local oficial do projeto é `nexus-notary`. Cadastre-o
uma vez no Keychain (a senha de app não fica no shell nem no repositório):

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # Node 22 LTS
xcrun notarytool store-credentials nexus-notary \
  --apple-id "seu@email.com" \
  --team-id "35P5XL3JN6" \
  --password "xxxx-xxxx-xxxx-xxxx"

npm ci
npm run typecheck
npm test
npm run premake # rebuild antes da chave privada entrar no keychain

env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD \
  APPLE_TEAM_ID=35P5XL3JN6 \
  APPLE_KEYCHAIN_PROFILE=nexus-notary \
  npm run make:release

# Opcional, para voltar o node_modules local ao ABI do Node depois do Forge.
env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID \
  npm run rebuild:node
```

O certificado esperado é exatamente
`Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)`. Depois do
`make`, rode o mesmo gate usado pelo CI; ele monta o DMG, extrai o ZIP do
updater e valida os dois apps contidos:

```bash
node scripts/verify-macos-release.mjs \
  --artifacts out/make \
  --version "$(node -p "require('./package.json').version")" \
  --bundle-id com.nexuside.app \
  --team-id 35P5XL3JN6 \
  --identity "Developer ID Application: Cleofas Pereira rocha"
```

Sem `APPLE_TEAM_ID`, o Forge produz deliberadamente uma assinatura **ad-hoc**
(`identity: -`), sem hardened runtime e sem notarização. Esse pacote serve só
para smoke local: Gatekeeper não o considera distribuível e ele nunca deve ser
publicado. O `.zip` é obrigatório em toda release, pois é o payload consumido
pelo auto-update Squirrel.Mac.

Detalhes de assinatura/notarização em [`build/notarize.md`](../build/notarize.md).
