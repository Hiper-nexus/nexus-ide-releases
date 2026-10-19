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
| Certificado | série `0FF90DF65ACAABCE88CF75190F9E2DE0`, ECC P-384, emitido em 19/10/2026 pela `SSL.com Code Signing Intermediate CA ECC R2`, válido até 22/07/2027; importado no slot 9a (cópia em `yubikey-ssl\codesign-0FF90DF6.crt`, com a cadeia ECC) |
| Thumbprint fixado | `41BB4AFD0B69AA7B8B88F732E66808A2A5B93560` |
| Driver | **YubiKey Smart Card Minidriver** (5.0.4.273). O driver PIV nativo do Windows (`msclmd.dll`) não expõe a chave ECC P-384: o `certutil -scinfo` dava `NTE_BAD_KEYSET` e o certificado nunca chegava à loja do usuário |

O SSL.com não emite sozinho para um pedido cadastrado no eSigner: a reemissão foi
pedida por ticket no chat e saiu como um segundo certificado no mesmo pedido. O
baixável antigo (série 7538CB4E…, RSA 3072) é o do eSigner e não combina com a
chave. O e-mail da emissão é o modelo do eSigner ("set your PIN", "issue
certificate"): ignore, o YubiKey não usa nada disso. A assinatura do eSigner
continua cobrando até o operador cancelá-la em Orders.

Prova de 19/10: `signtool sign /sha1 41BB4AFD… /fd sha256 /tr
http://timestamp.sectigo.com /td sha256` numa cópia do `StubExecutable.exe` deu
`Get-AuthenticodeSignature` = `Valid`, cadeia até a `SSL.com Root Certification
Authority ECC` e carimbo da Sectigo. Um artigo da Yubico diz que a Microsoft não
aceita certificado ECC para code signing; para Authenticode de modo usuário o
Windows aceitou. Assinatura de driver de kernel é outra regra e não é o caso do
Nexus.

## Quando um certificado novo sair (renovação; feito uma vez em 19/10)

0. No PC que assina, instale o **YubiKey Smart Card Minidriver** x64
   (downloads.yubico.com, confira o `.sha256` publicado e a assinatura Authenticode
   da Yubico AB no MSI). Sem ele o Windows não enxerga a chave ECC.
1. Em secure.ssl.com, Orders → `co-f01l53ldh43` → END ENTITY CERTIFICATES, baixe o
   `.zip` da entrada ECC (traz o certificado e a cadeia ECC). A entrada 7538CB4E…
   é a do eSigner.
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

   `HasPrivateKey` precisa ser `True`, e o `certutil` precisa mostrar a placa como
   "YubiKey Smart Card" (não "Identity Device (NIST SP 800-73 [PIV])", o driver
   nativo) com "Teste de correspondência de chave pública bem-sucedido". O Windows
   só propaga o certificado quando o cartão é conectado: depois de importar ou de
   instalar o minidriver, tire e recoloque o YubiKey. O serviço Propagação de
   Certificado (`CertPropSvc`) sobe sozinho com o cartão.
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
  pede o PIN a cada processo do SignTool (o minidriver só guarda o PIN dentro do
  processo). Medido em 19/10: **5 janelas por build completo**, uma para todos os
  `.exe`, `.dll` e `.node` do pacote (o `@electron/windows-sign` assina tudo numa
  chamada) e quatro do Squirrel, em sequência: o stub, o `squirrel.exe` do
  pacote, o `Update.exe` e o `Setup.exe`. A janela "Segurança do Windows" pode
  abrir atrás das outras, e uma janela cancelada ou perdida derruba o make
  ("Failed to sign … Update.exe"). Com o pacote já assinado em `out/`, refazer só o
  instalador (`electron-forge make --skip-package`) pede 4. Reduzir isso é trabalho
  em andamento; o PIN nunca vai para script, argv nem variável de ambiente.
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

## O que esta assinatura cobre (por produto)

| Produto | Windows | Como sai assinado |
|---|---|---|
| NexusIDE (app, DLLs e `.node` do pacote) | Sim | `npm run make` com `NEXUS_WINDOWS_YUBIKEY_SIGNING=1` (este runbook) |
| Redline no Windows (`resources\nexus-redline\NexusRedline.exe`) | Sim | Vai dentro do pacote do NexusIDE e é assinado na mesma chamada (conferido em 19/10: `Valid`, `41BB4AFD…`) |
| Instalador Squirrel (`Setup.exe`, `Update.exe`, stub) | Sim | O Squirrel assina na mesma build; o recibo confere os quatro executáveis |
| `d3dcompiler_47.dll`, `dxil.dll` | Não precisa | Já vêm assinadas pela Microsoft no Electron |
| Nexus Shot (repo `nexus-shot`, Tauri, NSIS) | **Ainda não** | Repositório próprio; o `tauri.conf.json` não tem assinatura Windows e o instalador público do v0.1.15 saiu sem assinatura. Ligar exige `bundle.windows.certificateThumbprint` = `41BB4AFD0B69AA7B8B88F732E66808A2A5B93560`, `digestAlgorithm: sha256` e `timestampUrl` RFC 3161 num `tauri.windows.conf.json`, o minidriver e o PIN como aqui |
| NexusIDE no macOS / Redline do Mac / Shot no Mac | Outro caminho | Developer ID + notarização (`build/notarize.md`, `docs/RELEASE.md`) |
| NexusIDE no Linux | Outro caminho | Ed25519 do `.sig` (F-940, `docs/RELEASE.md`) |

## Limites

- O `windows-release.yml` roda numa máquina do GitHub, sem o token: o candidato de
  lá continua `signing: 'none'`. Build assinado só no PC com o YubiKey.
- O pacote MSIX da Microsoft Store é outro caminho (a Store assina), sem relação
  com este.
