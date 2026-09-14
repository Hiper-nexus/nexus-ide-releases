# Windows: diagnóstico de build e assinatura — 14/09/2026

## Resultado

O certificado existente pode ser usado para assinar o executável do NexusIDE.
O portal identifica **OV Code Signing**, não EV. Não é necessário comprar
outro certificado para este teste de aplicativo desktop.

Ainda não foi gerado nem assinado um instalador Windows nesta análise.

## Evidência consultada ao vivo

No time atual da SSL.com há um pedido, `co-f01l53ldh43`:

| Campo | Estado observado |
| --- | --- |
| Titular | HIPERSEND TECNOLOGIA INTERNET & SOFTWARES LTDA |
| Pedido | 11/07/2026 |
| Emissão | 22/07/2026 |
| Validade | 22/07/2027 |
| Status no portal | issued |
| Modalidade | Code Signing, validação organization |
| Plano eSigner | OV Code Signing Tier 1 Monthly |
| Saldo exibido | 40 assinaturas não utilizadas |
| Armazenamento | eSigner ativo; zero tokens YubiKey |
| Segundo fator | OTP APP |

O eSigner Express abriu autenticado em `https://app.esigner.com/esigner-express/esign`.
A tela aceita arquivos de código de até 200 MB. Login no portal não comprova
posse do segundo fator nem uma operação de assinatura bem-sucedida.
Nenhuma assinatura foi consumida, PIN redefinido ou plano alterado.

## O que já existe no projeto

- Electron Forge com MakerSquirrel para gerar Setup.exe, pacote NUPKG e RELEASES.
- Smoke do aplicativo empacotado com suporte a win32 em
  `scripts/smoke-packaged-app.mjs`.
- Fluxo Windows x64 antigo em `docs/archive/release-actions-workflow.yml:384`.
  Está arquivado; não é um workflow executável atual.
- Configuração Authenticode em `forge.config.ts:190`, aplicada ao packager e
  ao MakerSquirrel, mas exige arquivo de certificado e senha.
- Alterações locais preexistentes para o ícone ICO do instalador e para tornar
  `appdmg` opcional. Esta análise não implementou essas alterações.

## Bloqueios identificados

1. **Configuração incompatível com a custódia da chave.** O caminho atual exige
   `WINDOWS_CERTIFICATE_FILE` e `WINDOWS_CERTIFICATE_PASSWORD`. O certificado
   eSigner tem chave na nuvem; baixar o bundle público não fornece um PFX com
   a chave privada. É preciso integrar CKA/SignTool ou outro cliente seguro.
2. **Integração antiga recusada.** O commit `7a69252b`, de 23/07/2026, registra
   em `build/notarize.md` que CodeSignTool 1.3.3 expõe senha/TOTP em argumentos
   de processo. A documentação atual do CodeSignTool ainda mostra esses
   parâmetros. Não reutilizar esse fluxo com credenciais reais.
3. **Build Windows não ativo.** Os workflows listados no GitHub foram CI e
   quality; não há runner próprio cadastrado no repositório. Não foi localizado
   um Setup.exe ou NUPKG do NexusIDE nos diretórios locais de artefatos.
4. **Instalação multiplataforma ainda precisa de prova.** O CI de 14/09/2026
   falhou em `npm ci`: `EBADPLATFORM` para `macos-alias@0.2.12`, exclusivo do
   macOS. A alteração local de `appdmg` para optionalDependencies aborda essa
   dependência, mas não foi validada em Windows nesta análise.
5. **Segundo fator pendente de confirmação pelo titular.** O portal está
   configurado para aplicativo autenticador. Não redefinir PIN/QR por conveniência.

CI consultado: https://github.com/Hiper-nexus/nexus-ide/actions/runs/34810050473

## Caminho recomendado para o primeiro teste

1. Preparar checkout isolado em Windows x64 (máquina/VM ou runner), com Node
   compatível com a versão fixada no projeto, Python e ferramentas C++ para
   reconstruir os módulos nativos. Usar um commit definido e incluir a correção
   multiplataforma e o ícone Windows após validação.
2. Executar instalação limpa, typecheck, testes focados de empacotamento e
   `security:renderer-sinks`. Reconstruir node-pty e better-sqlite3 para Electron
   no Windows. Validar o payload de ONNX e demais dependências nativas.
3. Gerar primeiro um candidato sem assinatura e executar o smoke Windows.
   Isso identifica erros de build/runtime antes de consumir o saldo de assinatura.
4. Instalar e configurar **eSigner CKA** no ambiente Windows de assinatura.
   Usar autenticação interativa para o primeiro teste. Integrar o certificado
   do Windows Certificate Store ao packager e ao MakerSquirrel por thumbprint,
   sem senha ou segredo TOTP na linha de comando. Essa integração ainda precisa
   ser implementada e testada; os parâmetros atuais de PFX não a fornecem.
5. Assinar os binários do aplicativo durante o empacotamento e os executáveis
   Squirrel/Setup na etapa correta, com SHA-256 e timestamp. Inventariar arquivos
   e estimar consumo antes do lote; 40 assinaturas não equivalem a 40 releases.
   Não alterar o conteúdo do NUPKG ou RELEASES após a geração final sem refazê-los.
6. Verificar assinatura e timestamp com SignTool e Get-AuthenticodeSignature.
   Confirmar o titular HIPERSEND no Setup e no aplicativo extraído/instalado.
   Gerar SHA-256 dos artefatos finais.
7. Instalar em Windows limpo e testar abertura, workspace, terminal PowerShell,
   persistência SQLite, providers, uma missão simples e encerramento de processos.
   Exercitar também desinstalação. Executar o smoke no pacote não substitui
   validar a instalação pelo Setup.exe.

O primeiro entregável deve ser um **candidato Windows x64 para teste**, com
assinatura e relatório de verificação. A prontidão para publicação e atualização
automática precisa de validação Windows própria; o checklist atual de release
é orientado a macOS.

## Alternativa pelo navegador

O eSigner Express já autenticado permite uma operação manual caso o arquivo
esteja dentro de 200 MB. É útil para uma primeira prova, mas assinar apenas o
Setup.exe não assina retroativamente o aplicativo dentro dele. O fluxo completo
precisa preservar a ordem: binários internos, empacotamento, instalador final.
Não usar o limite do portal web como conclusão sobre o limite do CKA, que
precisa ser validado com o artefato real.

## Referências oficiais

- [SSL.com: eSigner FAQ — OV, EV e chave não exportável](https://www.ssl.com/faqs/esigner-faq/)
- [SSL.com: eSigner CKA e SignTool](https://www.ssl.com/how-to/automate-ev-code-signing-with-signtool-or-certutil-esigner/)
- [SSL.com: parâmetros do CodeSignTool](https://www.ssl.com/guide/esigner-codesigntool-command-guide/)
- [Microsoft: reputação do SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

A Microsoft informa que assinatura EV não garante mais reputação imediata no
SmartScreen. Uma assinatura válida comprova o editor e a integridade; um binário
novo ainda pode receber aviso de reputação. Isso não justifica trocar o OV
existente para produzir este teste.
