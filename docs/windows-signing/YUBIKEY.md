# Assinatura Windows pelo YubiKey

Decisão do operador em 19/10/2026: o YubiKey substitui o eSigner da SSL.com, que
saiu do fluxo em 05/10 por cobrar cada assinatura (a build assina dezenas de
arquivos). Não é o eSigner religado: a chave mora no token, não na nuvem, e
assinar não gera cobrança.

## Estado

| Item | Valor |
|---|---|
| Token | YubiKey 5C NFC FIPS, série 25700086, firmware 5.4.3, PIV em modo FIPS |
| Chave | ECC P-384 gerada no slot 9a (PIN uma vez por sessão, sem toque) |
| SHA-256 do SPKI | `cc695904302f57c37532f709c25a9f25710bb04a2f23d1f89b42cf7430c4e3d0` |
| Atestação | `C:\Users\Administrador\Documents\yubikey-ssl\` (atestação do slot 9a + intermediário Yubico), aceita no pedido |
| Pedido SSL.com | `co-f01l53ldh43`, OV, HIPERSEND TECNOLOGIA INTERNET & SOFTWARES LTDA |
| Certificado | **ainda não reemitido** (19/10). O baixável hoje (série 7538CB4E…, RSA 3072) é o do eSigner e não combina com a chave; o `ykman --verify` o recusa |
| `build/windows-signing-identity.json` | `certificateSha1: null`: o modo recusa e a build sai sem assinatura |

O SSL.com não emite sozinho para um pedido cadastrado no eSigner: a reemissão foi
pedida por ticket no chat. A assinatura do eSigner continua cobrando até o
operador cancelá-la em Orders.

## Quando o certificado sair (uma vez)

1. Em secure.ssl.com, Orders → `co-f01l53ldh43` → END ENTITY CERTIFICATES precisa
   ter uma segunda entrada, ECC, que não é a série 7538CB4E…. O operador baixa o
   `.crt` dela.
2. Confira que o certificado é da chave do slot 9a (precisa imprimir o SPKI da
   tabela acima):

   ```powershell
   $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new('<arquivo.crt>')
   [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($cert.PublicKey.ExportSubjectPublicKeyInfo())).ToLowerInvariant()
   ```

3. **O operador** importa no slot (pede o PIN; ninguém digita PIN ou PUK por ele):

   ```powershell
   & 'C:\Program Files\Yubico\YubiKey Manager CLI\ykman.exe' piv certificates import --verify 9a '<arquivo.crt>'
   ```

4. Confira o slot e a propagação para a loja do usuário:

   ```powershell
   & 'C:\Program Files\Yubico\YubiKey Manager CLI\ykman.exe' piv info
   Get-ChildItem Cert:\CurrentUser\My | Where-Object Subject -match 'HIPERSEND' | Format-List Thumbprint, HasPrivateKey, Subject, NotAfter
   certutil -scinfo -silent
   ```

   `HasPrivateKey` precisa ser `True`. Se o certificado não aparecer, tire e
   recoloque o YubiKey; o serviço Propagação de Certificado (`CertPropSvc`) tem de
   estar rodando.
5. Prove a assinatura à mão numa cópia de qualquer executável (o Windows pede o
   PIN):

   ```powershell
   $signtool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe'
   & $signtool sign /sha1 <THUMBPRINT> /fd sha256 /tr http://timestamp.sectigo.com /td sha256 <copia.exe>
   Get-AuthenticodeSignature <copia.exe> | Format-List Status, SignerCertificate, TimeStamperCertificate
   ```

   `Status` = `Valid`, assinante HIPERSEND.
6. Fixe o thumbprint (maiúsculas) em `build/windows-signing-identity.json`
   (`certificateSha1`), rode
   `npx vitest run build/windows-token-signing.test.ts forge.config.test.ts scripts/windows-release-candidate.test.mjs`
   e faça o commit.

## Build assinado

```powershell
Remove-Item Env:NEXUS_WINDOWS_RELEASE_SIGNING, Env:WINDOWS_CERTIFICATE_SHA1, Env:WINDOWS_CERTIFICATE_FILE, Env:WINDOWS_CERTIFICATE_PASSWORD -ErrorAction SilentlyContinue
$env:NEXUS_WINDOWS_YUBIKEY_SIGNING = '1'
npm run make -- --platform win32 --arch x64
```

- Antes de empacotar, o Forge (`prePackage`/`preMake`) lê o certificado fixado em
  `Cert:\CurrentUser\My` sem tocar na chave e confere thumbprint, SPKI, CN da
  HIPERSEND, uso de assinatura de código, validade e a ligação com a chave do
  cartão. YubiKey fora da porta falha aqui, antes de qualquer arquivo assinado.
- O SignTool recebe `/sha1 <thumbprint>` da loja do usuário (sem `/sm`). O Windows
  pede o PIN a cada processo do SignTool: um para todos os `.exe`, `.dll` e `.node`
  do pacote (o `@electron/windows-sign` assina tudo numa chamada) e um para cada
  executável que o Squirrel assina depois (Update.exe, o stub e o Setup).
- Servidor de carimbo instável (`SignerSign() failed (0x80093102)` num arquivo
  diferente a cada tentativa, F-656): repita com
  `$env:NEXUS_WINDOWS_TIMESTAMP_URL = 'http://timestamp.sectigo.com'`.
- Depois do make, `scripts/collect-windows-release.ps1` grava no recibo
  `signing: 'yubikey'` e, por executável (Setup, app, Update.exe, stub), o
  thumbprint, o SPKI e o thumbprint do carimbo. Confira também à mão:
  `Get-AuthenticodeSignature` = `Valid` HIPERSEND no Setup e no `nexus-ide.exe`.

## O que recusa

- `NEXUS_WINDOWS_RELEASE_SIGNING` em qualquer valor (era o opt-in do eSigner).
- `NEXUS_WINDOWS_YUBIKEY_SIGNING` diferente de `1`.
- `WINDOWS_CERTIFICATE_FILE`, `WINDOWS_CERTIFICATE_PASSWORD`,
  `WINDOWS_CERTIFICATE_SHA1`, `WINDOWS_SIGN_WITH_PARAMS`, `WINDOWS_SIGNTOOL_PATH` e
  `WINDOWS_SIGN_HOOK_MODULE_PATH` junto do opt-in: o `@electron/windows-sign` os lê
  por baixo das opções e assinaria com outro certificado, outro signtool ou um
  hook.
- `certificateSha1` nulo, o thumbprint do eSigner no JSON, ou um certificado na
  loja cuja chave pública não seja a do slot 9a (mesmo com o thumbprint fixado).
- No coletor: executável assinado por outro certificado, sem carimbo, ou alguns
  assinados e outros não. No publicador: recibo `yubikey` cujas assinaturas não
  batem com o JSON.

## Renovação e troca de chave

- Certificado novo sobre a mesma chave (renovação anual): importe no slot 9a e
  troque só o `certificateSha1`.
- Chave nova (outro YubiKey ou slot regenerado): nova atestação, novo pedido de
  reemissão, e o `spkiSha256` do JSON muda junto com o thumbprint, revisados no
  mesmo commit.

## Limites

- O `windows-release.yml` roda numa máquina do GitHub, sem o token: o candidato de
  lá continua `signing: 'none'`. Build assinado só no PC com o YubiKey.
- O pacote MSIX da Microsoft Store é outro caminho (a Store assina), sem relação
  com este.
