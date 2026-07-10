# Assinatura & Notarização do NexusIDE (macOS)

Para que o `.dmg` abra **limpo em qualquer Mac** (sem o erro "está danificado"
nem "desenvolvedor não identificado"), o build precisa ser **assinado com um
Developer ID Application** e **notarizado pela Apple**.

Isso já está cabeado no `forge.config.ts`: release exige o certificado
`Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)` e ativa
hardened runtime/notarização quando `APPLE_TEAM_ID` existe. Sem Team ID, o
`make` usa assinatura **ad-hoc** (`identity: -`), sem hardened runtime e sem
notarização. O pacote ad-hoc é apenas para smoke local e não pode ser publicado.

## Pré-requisitos (uma vez só)

### 1. Certificado Developer ID Application
1. Gere uma CSR (Certificate Signing Request):
   - Abra **Acesso às Chaves** → menu **Acesso às Chaves → Assistente de
     Certificado → Solicitar um Certificado de uma Autoridade de Certificação**
   - E-mail: seu Apple ID · Nome comum: seu nome · marque **Salvo em disco**
2. No portal <https://developer.apple.com/account/resources/certificates/list>:
   - **+** → **Developer ID Application** → envie a CSR → baixe o `.cer`
3. Duplo-clique no `.cer` para instalar no Keychain **login**.
4. Confirme: `security find-identity -v -p codesigning` deve listar
   `Developer ID Application: Seu Nome (TEAMID)`.

### 2. Perfil `nexus-notary` no Keychain (recomendado localmente)
1. <https://appleid.apple.com> → **Login e Segurança → Senhas de app** →
   gere uma nova (ex.: nome "notarytool"). Guarde a senha `xxxx-xxxx-xxxx-xxxx`.
2. Armazene-a diretamente no Keychain:
   ```bash
   xcrun notarytool store-credentials nexus-notary \
     --apple-id "seu@email.com" \
     --team-id "35P5XL3JN6" \
     --password "xxxx-xxxx-xxxx-xxxx"
   ```
3. Teste sem expor a senha no ambiente:
   ```bash
   xcrun notarytool history --keychain-profile nexus-notary
   ```

### 3. Team ID
- Aparece entre parênteses no nome do certificado, ou em
  <https://developer.apple.com/account> → **Membership**.

## Build de release

Instale/reconstrua tudo antes de a chave privada estar disponível e só então
rode o target de release (não exporte a senha de app):

```bash
npm ci
npm run typecheck
npm test
npm run premake

env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD \
  APPLE_TEAM_ID=35P5XL3JN6 \
  APPLE_KEYCHAIN_PROFILE=nexus-notary \
  npm run make:release

# Restaura o ABI do Node para continuar o desenvolvimento local.
env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID \
  npm run rebuild:node
```

No GitHub Actions, onde o perfil local não existe, o workflow usa os secrets
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID`. A notarização
adiciona alguns minutos (upload + validação da Apple). O Forge faz o *staple*
do ticket no `.app` antes de gerar DMG e ZIP.

## Verificar antes de distribuir

```bash
node scripts/verify-macos-release.mjs \
  --artifacts out/make \
  --version "$(node -p "require('./package.json').version")" \
  --bundle-id com.nexuside.app \
  --team-id 35P5XL3JN6 \
  --identity "Developer ID Application: Cleofas Pereira rocha"
```

O gate exige exatamente um DMG e um ZIP (o ZIP alimenta o Squirrel.Mac), monta
o DMG como somente leitura e extrai o ZIP em diretório temporário. Em **cada**
app contido ele revalida versão, bundle ID, assinatura strict de todos os
Mach-O, Authority/TeamIdentifier, Gatekeeper, ticket stapled, entitlements por
tipo de processo, fuses e o smoke isolado com userData temporário. Só depois
disso os artefatos podem ser publicados.

Os perfis de entitlement são deliberadamente separados:

- app principal e Renderer Helper: V8 JIT + entrada de áudio (o Renderer
  executa `getUserMedia`/WebAudio);
- helpers GPU/utility: apenas V8 JIT;
- helper Plugin: apenas memória executável exigida pelo helper;
- frameworks, dylibs, módulos nativos e crashpad: nenhum entitlement.

Nenhum perfil permite variáveis DYLD, desabilita library validation ou
desabilita executable-page protection.

## Canal de atualização

Assinar e publicar um ZIP não cria, por si só, auto-update para usuários finais.
O app só usa Squirrel diretamente quando recebe um `NEXUS_UPDATE_FEED` HTTPS
confiável. Sem esse feed, o caminho alternativo depende de `gh` autenticado e é
adequado apenas para instalações de desenvolvimento do repositório privado.
Antes de prometer atualização automática, provisione e teste o feed em um
domínio Nexus confiável com ZIPs separados para `darwin-arm64` e `darwin-x64`.
