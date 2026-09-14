# Continuar o NexusIDE no Windows

Handoff de 14/09/2026. Repositório privado: `Hiper-nexus/nexus-ide`.
Branch de trabalho: `codex/windows-test-20260914`.
Último commit de código neste handoff: `f4f6c666`.
O commit deste documento acrescenta somente documentação e certificado público.

## Começar na máquina Windows

Use Windows x64. Instale Git, Node **22.23.2**, Python e Visual Studio Build
Tools com C++ e Windows SDK. Entre no GitHub com uma conta que tenha acesso
ao repositório privado. Em uma pasta de desenvolvimento, execute no PowerShell:

```powershell
git clone --branch codex/windows-test-20260914 https://github.com/Hiper-nexus/nexus-ide.git nexus-ide
Set-Location nexus-ide
git status
node --version
npm ci
```

Se já houver um clone nessa máquina, preserve alterações locais e busque esta
branch nele; não substitua arquivos nem use reset forçado.

Para continuar com outro agente, peça:

> Continue a versão Windows do NexusIDE a partir de
> docs/windows-signing/CONTINUAR-NO-WINDOWS.md na branch
> codex/windows-test-20260914. Leia AGENTS.md e os documentos de segurança antes
> de editar o PTY. Verifique os resultados atuais do GitHub Actions. Termine a
> integração e os testes Windows, configure a assinatura SSL.com eSigner CKA
> comigo e valide instalação e atualização N→N+1. Preserve as alterações
> existentes. Não declare publicado ou assinado antes da evidência real.

## O que já está no GitHub

- Empacotamento Windows/Squirrel, ícone ICO e dependência macOS opcional.
- Assinatura pelo thumbprint do Certificate Store via CKA, tanto no aplicativo
  quanto no instalador, com timestamp. Não precisa de senha em argumentos.
- Workflow privado de preview Windows x64 e workflow de candidato assinado.
- Atualizador Windows instalado usando o feed oficial de
  `Hiper-nexus/nexus-ide-releases`, com espera de primeira execução.
- Publicação conjunta Mac/Windows com verificação dos artefatos e exigência de
  prova real de atualização instalada.
- Correções de caminhos longos SQLite, backup/fsync, shell PowerShell/cmd,
  leitura do ASAR, normalização de sequências do terminal e diagnóstico de saída.
- Fixture nativo de Job Objects em `native/windows-pty-job/`.
- Certificado público nos arquivos `.pem` e `.cer` desta pasta.

Código e scripts estão versionados. `node_modules`, caches e binários de testes
antigos devem ser gerados novamente, não são pré-requisitos locais deste Mac.

## Certificado e assinatura

O certificado encontrado é **OV Code Signing**, não EV. Titular:
**HIPERSEND TECNOLOGIA INTERNET & SOFTWARES LTDA**.
Validade observada: 22/07/2026 a 22/07/2027, 16:02:44 UTC.

Thumbprint SHA-1 público verificado no PEM:

```text
E44D98FF840B1DF78D87F6768D177B5719952CAB
```

Arquivos: [PEM](certificate/HIPERSEND-Code-Signing-publico.pem) e
[CER](certificate/HIPERSEND-Code-Signing-publico.cer). Ambos contêm somente o
certificado público. A chave privada é não exportável e permanece no eSigner
da SSL.com. Importar o CER sozinho não habilita a assinatura.

Instale o **eSigner CKA da fonte oficial SSL.com** no Windows, entre na conta
SSL.com do titular e conclua o autenticador no próprio aplicativo. Senha,
PIN, OTP, segredos do autenticador e sessões não devem ser colocados no GitHub.

Com o CKA pronto, confirme a presença do certificado na loja Local Machine do
Windows que executará o build:

```powershell
Get-ChildItem Cert:\LocalMachine\My -CodeSigningCert |
  Format-List Subject, Thumbprint, NotAfter, HasPrivateKey
```

Após concluir as correções e os testes, a configuração do build assinado é:

```powershell
$env:NEXUS_WINDOWS_RELEASE_SIGNING = '1'
$env:WINDOWS_CERTIFICATE_SHA1 = 'E44D98FF840B1DF78D87F6768D177B5719952CAB'
npm run make -- --platform win32 --arch x64
```

O aplicativo e o Setup observados excederam 200 MB, limite do eSigner Express
web. O caminho preparado é CKA nativo. Havia 40 assinaturas disponíveis na
consulta inicial; reconfirme o saldo. Um pacote contém vários arquivos PE e
pode consumir várias assinaturas. Nenhuma assinatura foi consumida nesta tarefa.

Procedimento completo de build e verificação:
[WINDOWS-PREVIEW-AND-SIGNING.md](../WINDOWS-PREVIEW-AND-SIGNING.md).

## Estado real e pendências

1. **Revalidar CI.** O preview [34853337571](https://github.com/Hiper-nexus/nexus-ide/actions/runs/34853337571)
   estava em execução no handoff, com instalação de dependências aprovada.
   Não presumir que terminou com sucesso.
2. **Integrar o encerramento nativo dos terminais.** Os seis cenários isolados
   passaram no [run 34853134630](https://github.com/Hiper-nexus/nexus-ide/actions/runs/34853134630).
   Isso ainda não comprova N-API, DLL ConPTY vendorizada nem Electron empacotado.
   Leia o [desenho completo](windows-native-job-lifecycle-design.md) e o
   [suplemento de integração](windows-native-integration-onepage.md). O suplemento
   substitui a proposta anterior de diretório do addon. Os caminhos temporários
   do Mac no desenho são referências históricas: baixe/verifique a fonte exata
   pelas URLs/SRI documentadas no Windows. Não são dependências do build.
3. **Não confundir smoke com prova física.** O smoke Windows atual pode terminar
   sem prova positiva de encerramento; `shutdown-unproven` é uma limitação real.
   Mantenha RunAsNode desabilitado. Não use enumeração de PIDs/CIM/taskkill como
   substituto de propriedade nativa do grupo de processos.
4. **CLIs via npm (.cmd).** F-524 permanece aberto. O preview usa o executável
   nativo do Codex como pré-requisito de teste; isso não corrige todos os shims
   npm. Veja a [recomendação de compatibilidade](windows-cli-compatibility.md).
5. **Instalar e testar o candidato assinado.** Verificar Authenticode/timestamp
   do Setup, executável interno, componentes Squirrel e arquivos PE aplicáveis.
   Testar abertura, projeto, terminal, autenticação de CLI, missão, persistência,
   encerramento e desinstalação em Windows.
6. **Atualização real N→N+1.** Implementar/executar o harness instalado e ligar
   a prova ao commit, versão, run e hashes corretos. O coletor atual emite
   `installedUpgradeVerified=false`; não trocar por true sem prova. Arquivos
   finais precisam de Setup com marcador `-win32-x64-`, full NUPKG e RELEASES.
7. **Atualizações contínuas.** Provisionar runner Windows protegido com CKA sob
   a conta do serviço, label `nexus-release-signing`, ambiente GitHub
   `windows-release-signing`, thumbprint público e proteção de main. Esses itens
   não foram configurados. O estado consultado de main era `protected=false`.
8. **Integrar com main atual.** A branch Windows divergiu de main. Não forçar
   push nem sobrescrever main: integrar a versão atual, resolver conflitos e
   repetir verificações antes de promover o candidato. A publicação pública
   consultada era v0.76.24, somente Mac ARM64; Windows não está publicado.

Fontes de release: [RELEASE.md](../RELEASE.md) e
[RELEASE-CHECKLIST.md](../RELEASE-CHECKLIST.md). Nada neste handoff autoriza
tratar preview sem assinatura como release de produção.
