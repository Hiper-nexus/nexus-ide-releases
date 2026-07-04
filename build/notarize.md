# Assinatura & Notarização do NexusIDE (macOS)

Para que o `.dmg` abra **limpo em qualquer Mac** (sem o erro "está danificado"
nem "desenvolvedor não identificado"), o build precisa ser **assinado com um
Developer ID Application** e **notarizado pela Apple**.

Isso já está cabeado no `forge.config.ts`: ele só ativa quando as variáveis de
ambiente abaixo existem. Sem elas, o `make` gera um build local não assinado.

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

### 2. App-Specific Password (para notarização)
1. <https://appleid.apple.com> → **Login e Segurança → Senhas de app** →
   gere uma nova (ex.: nome "notarytool"). Guarde a senha `xxxx-xxxx-xxxx-xxxx`.

### 3. Team ID
- Aparece entre parênteses no nome do certificado, ou em
  <https://developer.apple.com/account> → **Membership**.

## Build de release

Exporte as credenciais e rode o make (NÃO commite estes valores):

```bash
export APPLE_ID="seu@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"

npm run make
```

A notarização adiciona alguns minutos (upload + validação da Apple). O Forge
faz o *staple* do ticket automaticamente no `.app` dentro do `.dmg`.

## Verificar antes de distribuir

```bash
# Assinatura válida e hardened runtime?
codesign -dv --verbose=4 "out/NexusIDE-darwin-arm64/NexusIDE.app" 2>&1 | grep -E "Authority|flags"

# Gatekeeper aprova? (deve dizer "accepted" / "Notarized Developer ID")
spctl -a -vvv -t install "out/make/.../NexusIDE.app" 2>&1

# Ticket de notarização grampeado?
xcrun stapler validate "out/make/.../NexusIDE-0.1.4-arm64.dmg"
```

Se os três passarem, o `.dmg` abre sem avisos em qualquer Mac.
