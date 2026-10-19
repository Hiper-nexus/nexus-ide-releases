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
- Em seguida o Forge liga o **agente de assinatura** (seção abaixo) ou reaproveita
  o que já está destrancado. É o único ponto do build em que o Windows pode pedir
  o PIN: no máximo uma janela, e nenhuma enquanto o agente vive.
- Nenhum SignTool roda. O packager e o Squirrel chamam o hook
  `scripts/windows-signer/client.cjs`, que pede cada assinatura ao agente. Depois
  do pacote, o `postPackage` confere pelo agente cada `.exe`, `.dll` e `.node` do
  `out\NexusIDE-win32-x64` (assinatura válida e do certificado fixado).
- Servidor de carimbo instável (`0x80093102` num arquivo diferente a cada
  tentativa, F-656): o agente já repete o carimbo três vezes por arquivo. Se ainda
  falhar, troque o servidor no build, sem reiniciar o agente:
  `$env:NEXUS_WINDOWS_TIMESTAMP_URL = 'http://timestamp.sectigo.com'`.
- Depois do make, `scripts/collect-windows-release.ps1` grava no recibo
  `signing: 'yubikey'` e, por executável (Setup, app, Update.exe, stub), o
  thumbprint, o SPKI e o thumbprint do carimbo. Confira também à mão:
  `Get-AuthenticodeSignature` = `Valid` HIPERSEND no Setup e no `nexus-ide.exe`.

## Agente de assinatura: um PIN por dia

O Windows pede o PIN a cada **processo** que usa a chave do cartão (o minidriver
e o provedor de chaves guardam o PIN por processo). Com o SignTool eram 5 janelas
por build completo (medido em 19/10): uma para o pacote e uma por executável que
o Squirrel assina (stub, `squirrel.exe`, `Update.exe`, `Setup.exe`), cada uma num
signtool novo. A janela "Segurança do Windows" abria atrás das outras, e uma
janela perdida derrubava o make ("Failed to sign … Update.exe").

O agente (`scripts/windows-signer/agent.cjs`) segura a chave num só processo:
o motor `engine.cs`, compilado em memória num `powershell.exe` 5.1, que assina
por `SignerSignEx2` (SHA-256, carimbo RFC 3161) e confere cada arquivo
(`WinVerifyTrust` + assinante = certificado fixado). A janela de PIN é a do
próprio Windows, presa à janela que estava à frente quando o agente subiu, e o
PIN fica no cache do provedor do cartão, dentro do motor. **Ninguém digita, lê,
grava ou repassa o PIN, nem este código:** só o operador, na janela do Windows.

```powershell
npm run windows-signer -- start    # abre a janela de PIN do Windows; vale 24 h
npm run windows-signer -- status   # vivo? até quando?
npm run windows-signer -- stop     # encerra (o PIN some com ele)
```

- **Prazo.** `NEXUS_WINDOWS_SIGNER_HOURS` (no `start` ou no build que sobe o
  agente): 24 por padrão, de 1 a 168 (uma semana), ou `0` = só este build (o
  agente morre com o processo do make). Build que encontra um agente destrancado
  com pelo menos 45 min de prazo o reaproveita **sem PIN**; perto de vencer, sobe
  outro (uma janela).
- **Quando ele morre.** Prazo vencido, `stop`, motor encerrado, logoff ou
  reinício, e YubiKey que perdeu o PIN (removido, sono que reinicia o cartão):
  antes de cada assinatura o motor prova o PIN em cache com uma assinatura
  silenciosa e, sem ele, o agente encerra em vez de abrir uma janela escondida no
  meio do build. O próximo build sobe outro (uma janela).
- **Onde.** `%LOCALAPPDATA%\NexusIDE\windows-signer\`: `agent.json` (pipe e token
  da sessão, nunca o PIN), `agent.log` e `signed.ndjson` (data, caminho e SHA-256
  de tudo o que o agente assinou). Confira o diário quando quiser saber o que foi
  assinado com a chave da HIPERSEND.
- **O que ele assina.** Só `.exe`, `.dll` e `.node`, arquivo comum, com o caminho
  real (junction resolvida) dentro do `out\` de um checkout cujo
  `build/windows-signing-identity.json` fixa este certificado, da
  `%LOCALAPPDATA%\SquirrelTemp` ou do staging `electron-packager` no TEMP de quem
  pede. Pedido sem o token do `agent.json` é recusado.
- **O risco que o prazo compra.** Enquanto vive, o agente é um assinador para
  qualquer processo deste usuário do Windows que leia o `agent.json`: um malware
  rodando como o operador poderia assinar um `.exe` posto numa dessas pastas.
  A lista de pastas é cinto de segurança, não fronteira. Por isso o padrão é 24 h,
  não uma semana, e o diário registra cada assinatura. Em máquina compartilhada
  ou suspeita, use `NEXUS_WINDOWS_SIGNER_HOURS=0`.
- **Falha não passa.** O `@electron/windows-sign` engole o erro do hook
  (`sign-with-hook.js` só registra): o hook marca saída 1, que faz o signtool falso
  do Squirrel parar o make, e o `postPackage` recusa o pacote com falha registrada
  ou executável sem a assinatura certa.
- **Alternativa avaliada:** o `sign` da Microsoft (dotnet/sign) assina vários
  arquivos num processo, mas o Squirrel abre um processo por executável e cada um
  pediria o PIN de novo; não resolve sem um agente como este, e exigiria o SDK do
  .NET 8 no PC que assina.
- Prova de 19/10: o operador digitou o PIN uma vez (`start`, 5,6 s entre pedir e
  destrancar) e um executável de prova saiu `Valid`, HIPERSEND, carimbo Sectigo,
  em 1,1 s e sem segunda janela. Em seguida, `npm run make` completo (commit
  `1db471270`, carimbo Sectigo) com **zero** janelas: "agente reaproveitado, sem
  PIN", 23 executáveis do pacote e os 4 do Squirrel assinados pelo agente, make em
  7 min 18 s, coletor com `signing: 'yubikey'` (Setup, app, Update.exe e stub com o
  thumbprint e o carimbo) e `Get-AuthenticodeSignature` `Valid` no Setup e nos
  executáveis do nupkg.
- `d3dcompiler_47.dll` e `dxil.dll` aparecem no `Get-AuthenticodeSignature` como
  "Microsoft Windows" (`SignatureType = Catalog`): o hash Authenticode deles está
  num catálogo do sistema e a assinatura embutida não muda esse hash. A embutida é
  a da HIPERSEND, igual ao que o SignTool fazia.
- Coletor (`collect-windows-release.ps1`) com `RUNNER_TEMP` de caminho longo (o
  scratchpad do Claude) falha no smoke do app extraído do nupkg; use uma pasta
  curta, como `$env:TEMP\nxrt`.

## O que recusa

- `NEXUS_WINDOWS_RELEASE_SIGNING` em qualquer valor (era o opt-in do eSigner).
- `NEXUS_WINDOWS_YUBIKEY_SIGNING` diferente de `1`.
- `WINDOWS_CERTIFICATE_FILE`, `WINDOWS_CERTIFICATE_PASSWORD`,
  `WINDOWS_CERTIFICATE_SHA1`, `WINDOWS_SIGN_WITH_PARAMS`, `WINDOWS_SIGNTOOL_PATH` e
  `WINDOWS_SIGN_HOOK_MODULE_PATH` junto do opt-in: o `@electron/windows-sign` os lê
  por baixo das opções e assinaria com outro certificado, outro signtool ou um
  hook. `NEXUS_WINDOWS_SIGNER_DIR` (mandaria o hook a outro agente) também.
- `NEXUS_WINDOWS_SIGNER_HOURS` fora de 0 a 168.
- No agente: certificado aberto pelo motor com outro thumbprint ou outra chave
  (recusado antes de pedir o PIN), arquivo fora das pastas de build, que não seja
  `.exe`/`.dll`/`.node`, ou carimbo que não seja URL http(s).
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
- O agente não sobrevive a logoff, reinício nem à retirada do YubiKey: depois
  disso o primeiro build (ou o `start`) pede o PIN de novo. Build sem ninguém na
  frente do PC só funciona com um agente já destrancado.
- **Dois builds Windows não rodam ao mesmo tempo nesta máquina.** O
  `@electron/packager` apaga `%TEMP%\electron-packager` inteiro quando começa
  (`dist/packager.js`), e em 19/10 o início de um make derrubou outro com `ENOENT`
  no meio do pacote. `TEMP`/`TMP` próprios por build separam o packager (o agente
  aceita o `electron-packager` do TEMP de quem pede), mas o Squirrel continua
  usando `%LOCALAPPDATA%\SquirrelTemp\tempb`: dois makes nunca passam pelo Squirrel
  juntos. Confira antes (`tasklist | findstr /i "Squirrel electron-forge"` e as
  outras sessões).
- O pacote MSIX da Microsoft Store é outro caminho (a Store assina), sem relação
  com este.
