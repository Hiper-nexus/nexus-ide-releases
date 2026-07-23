# Perfil de verificação OWASP ASVS L2 — NexusIDE

**Versão do perfil:** 2026-07-23

**Referência normativa:** OWASP Application Security Verification Standard

**v5.0.0** (maio de 2025)

**Alvo:** Level 2, isto é, requisitos L1 + L2 aplicáveis

Este documento é um **perfil de verificação**, não uma certificação, atestado de
conformidade ou substituto para pentest independente. A OWASP define o ASVS para
aplicações e serviços web; por isso o alvo direto é o servidor/API/web do Nexus.
Controles do Electron entram somente quando existe uma fronteira análoga de
renderer, IPC, arquivo, segredo ou operação privilegiada.

A fonte está fixada na
[release oficial v5.0.0](https://github.com/OWASP/ASVS/tree/v5.0.0), que a
[OWASP identifica como a versão estável](https://github.com/OWASP/ASVS#latest-stable-version---500).
Os identificadores seguem o formato recomendado pela própria OWASP, por exemplo
`v5.0.0-1.2.4`; conteúdo de `master`/“bleeding edge” não altera este perfil.

## Escopo e critérios

Incluído:

- API Express, autenticação, billing, times, sync e persistência em
  [`server/src`](../../server/src);
- páginas web do servidor e shell PWA do companion;
- boundaries Electron main/preload/renderer, IPC/MCP, workspace, anexos e cofre
  local, quando análogos a um controle ASVS;
- dependências e artefatos de segurança da release local.

Fora do controle direto do repositório:

- segurança interna de GitHub, Google, Stripe, Apple, provedores de IA e IdPs;
- TLS, HSTS, proxy, WAF, DNS, banco gerenciado, secret manager e retenção de
  logs do ambiente de produção;
- código dos projetos abertos ou gerado por agentes;
- TURN, mídia e sinalização WebRTC operados por terceiros.

Estados usados abaixo:

- **evidência implementada:** há controle e teste local para os requisitos
  citados; não significa que todo o capítulo esteja conforme;
- **parcial:** existem controles, mas faltam cobertura, evidência de runtime ou
  requisitos L2;
- **externo/não verificado:** depende de infraestrutura ou terceiro e precisa de
  evidência separada;
- **N/A:** a função não existe no escopo declarado.

## Matriz de verificação

| Área ASVS v5.0.0 | Estado | Evidência local | Lacuna ou limite explícito |
|---|---|---|---|
| V1 Encoding/Sanitization e V2 Validation/Business Logic (`v5.0.0-1.2.4`, `v5.0.0-2.2.1`, `v5.0.0-2.2.2`, `v5.0.0-2.3.3`) | Parcial | Schemas e limites em [`env.ts`](../../server/src/env.ts) e [`sync-routes.ts`](../../server/src/sync/sync-routes.ts); consultas Drizzle parametrizadas; testes de contrato em [`sync-routes.test.ts`](../../server/src/sync/sync-routes.test.ts) | Nem toda rota e resposta de provedor usa schema estrito; falta inventário requisito a requisito de todas as entradas L2 |
| V3 Web Frontend (`v5.0.0-3.2.1`, `v5.0.0-3.4.4`, `v5.0.0-3.4.5`, `v5.0.0-3.5.5`) | Parcial | CSP fail-closed, renderer isolado e navegação negada em [`window.ts`](../../src/main/window.ts), com [`window-security.test.ts`](../../src/main/window-security.test.ts); headers do PWA em [`remote-client-server.ts`](../../src/main/remote/remote-client-server.ts) | Headers do site público não estão demonstrados em todas as respostas; HSTS/CSP/referrer policy no edge e teste dinâmico permanecem não verificados. V3.3 cookies é N/A para a sessão da API, que usa Bearer |
| V4 API/Web Service (`v5.0.0-4.2.1`, `v5.0.0-4.4.1`–`v5.0.0-4.4.4`) | Parcial | Limite de body, rate limit e erros genéricos em [`index.ts`](../../server/src/index.ts); autenticação do canal remoto por chave em [`remote-device-authority.ts`](../../src/main/remote/remote-device-authority.ts) e teste correspondente | Request smuggling depende também de proxy; WSS, Origin, token binding e certificado precisam de prova no deploy real. GraphQL (V4.3) é N/A |
| V5 File Handling (`v5.0.0-5.2.2`, `v5.0.0-5.3.2`, `v5.0.0-5.4.1`) | Parcial no boundary Electron; N/A para upload público do servidor | Staging privado, limites, `O_NOFOLLOW`, ownership e revalidação canônica em [`dropped-files.ts`](../../src/main/persistence/dropped-files.ts), com ataques de symlink/hardlink cobertos em [`dropped-files.test.ts`](../../src/main/persistence/dropped-files.test.ts); confinamento em [`scoped-workspace-fs.test.ts`](../../src/main/security/scoped-workspace-fs.test.ts) | Não há validação por magic bytes para todo tipo anexado; o arquivo é evidência para agente, não upload servido pelo site |
| V6 Authentication (`v5.0.0-6.3.1`, `v5.0.0-6.8.1`) | Parcial/externo | OAuth com state, PKCE S256 e limiter em [`auth-routes.ts`](../../server/src/auth/auth-routes.ts); merge por `(provider, subject)` e email verificado em [`account-service.ts`](../../server/src/auth/account-service.ts); testes em [`auth-routes.test.ts`](../../server/src/auth/auth-routes.test.ts) e [`account-service.test.ts`](../../server/src/auth/account-service.test.ts) | Senhas locais (V6.2) são N/A. MFA, recuperação e força de autenticação são responsabilidade dos IdPs e não foram verificadas |
| V7 Session Management (`v5.0.0-7.2.1`–`v5.0.0-7.2.4`, `v5.0.0-7.4.1`) | Parcial com evidência implementada para tokens | Tokens de referência aleatórios, hash no banco, expiração, rotação de refresh, detecção de reuso e revogação em [`session-service.ts`](../../server/src/auth/session-service.ts), cobertos por [`session-service.test.ts`](../../server/src/auth/session-service.test.ts) | Faltam política documentada de inatividade, limite de sessões concorrentes e UI para listar/encerrar sessões conforme L2 |
| V8 Authorization (`v5.0.0-8.2.1`–`v5.0.0-8.3.1`, `v5.0.0-8.4.1`) | Parcial | Autorização no serviço em [`require-auth.ts`](../../server/src/middleware/require-auth.ts); isolamento entre contas e CAS em [`sync-routes.test.ts`](../../server/src/sync/sync-routes.test.ts); owner/member em [`team-routes.test.ts`](../../server/src/team/team-routes.test.ts); autoridade MCP em [`mcp-dispatch-security.test.ts`](../../src/main/orch/mcp-dispatch-security.test.ts) | Falta matriz formal de função, objeto e campo para todas as rotas e todos os tenants |
| V9 Self-contained Tokens (`v5.0.0-9.1.1`–`v5.0.0-9.2.3`) | Parcial; aplicável às licenças, não às sessões | Licença EdDSA com algoritmo allowlisted, assinatura e expiração em [`license-signer.ts`](../../server/src/auth/license-signer.ts), com [`license-signer.test.ts`](../../server/src/auth/license-signer.test.ts) | Inventário de audience/purpose e ciclo completo das chaves de licença ainda não é evidência L2 |
| V10 OAuth/OIDC (`v5.0.0-10.1.2`, `v5.0.0-10.2.1`) | Parcial | Transação vinculada a state/PKCE e auth-code de uso único em [`oauth-flow.ts`](../../server/src/auth/oauth-flow.ts) e [`auth-code-service.ts`](../../server/src/auth/auth-code-service.ts), com [`auth-code-service.test.ts`](../../server/src/auth/auth-code-service.test.ts) | Respostas de userinfo são convertidas sem schema runtime completo; controles internos dos authorization servers são externos |
| V11 Cryptography (`v5.0.0-11.2.1`, `v5.0.0-11.4.1`, `v5.0.0-11.5.1`) | Parcial | Primitivas de Node/Jose, 256 bits de aleatoriedade em [`tokens.ts`](../../server/src/auth/tokens.ts), PKCE SHA-256 e licença Ed25519 | Faltam política formal, inventário, rotação e evidência de ciclo de vida de todas as chaves |
| V12 Secure Communication (`v5.0.0-12.1.1`, `v5.0.0-12.2.1`, `v5.0.0-12.3.1`–`v5.0.0-12.3.4`) | Externo/não verificado | URLs fixas HTTPS para IdPs em [`oauth-providers.ts`](../../server/src/auth/oauth-providers.ts); política HTTPS do backend desktop em [`backend-url.ts`](../../src/main/backend-url.ts) e [`backend-url.test.ts`](../../src/main/backend-url.test.ts); SSH tem verificação dedicada | Versões/ciphers TLS, certificados públicos, proxy e DB TLS só podem ser aprovados com inspeção do ambiente. Certificado self-signed do companion web não equivale a pinning verificável pelo browser |
| V13 Configuration e V14 Data Protection (`v5.0.0-13.3.1`, `v5.0.0-13.4.2`, `v5.0.0-14.2.4`, `v5.0.0-14.3.2`) | Parcial | Env fail-closed e redução de segredos ambientes em [`index.ts`](../../server/src/index.ts); cofre `safeStorage`/Keychain fail-closed em [`secrets-store.ts`](../../src/main/persistence/secrets-store.ts) e [`secrets-store.test.ts`](../../src/main/persistence/secrets-store.test.ts); redação em [`command-redaction.test.ts`](../../src/main/terminal/command-redaction.test.ts) | Secret manager do backend, classificação, retenção, purge e política de privacidade/logs dependem de documentação e deploy |
| V15 Secure Coding/Architecture (`v5.0.0-15.1.2`, `v5.0.0-15.2.1`) | Evidência de gate implementada; perfil geral parcial | Lockfile; `npm run release:security` executa audit de produção fail-closed, gera SBOM CycloneDX e manifesto com SHA-256 em [`release-security-gate.mjs`](../../scripts/release-security-gate.mjs), testado por [`release-security-gate.test.mjs`](../../scripts/release-security-gate.test.mjs) | O gate precisa passar no commit exato de cada release; prazo de correção de componentes e assinatura externa do SBOM ainda não estão formalizados |
| V16 Logging/Error Handling (`v5.0.0-16.2.5`, `v5.0.0-16.3.2`, `v5.0.0-16.5.1`–`v5.0.0-16.5.3`) | Parcial | Erro externo genérico em [`errors.ts`](../../server/src/middleware/errors.ts); despacho MCP persiste intenção/resultado e falha fechado se auditoria não estiver disponível, coberto em [`mcp-dispatch-security.test.ts`](../../src/main/orch/mcp-dispatch-security.test.ts) | Faltam inventário de logs, retenção, correlação global, transporte imutável e monitoramento/alerta do ambiente |
| V17 WebRTC | Externo/N/A para serviço Nexus | O desktop usa mídia de provedor, mas o Nexus não opera TURN, media server ou signaling server próprios no escopo atual | Exigir evidência contratual/técnica do provedor se essa fronteira entrar no alvo de certificação |

## Gate local obrigatório por release

Execute no commit exato que receberá a tag:

```bash
npm run typecheck
npm test
npm --workspace server run typecheck
npm --workspace server test
npm run release:security
```

`npm run release:security` bloqueia vulnerabilidade conhecida na árvore de
produção e produz, em `release-artifacts/security/`, o relatório de audit, o
SBOM CycloneDX e um manifesto com tamanho e SHA-256. Esses arquivos são
evidência de release; não provam, isoladamente, ASVS L2.

## Bloqueadores para declarar “ASVS L2 verificado”

1. Completar uma checklist individual para **todo** requisito L1/L2 aplicável,
   com resultado, evidência, responsável e data.
2. Fechar validação estrita de todas as entradas HTTP e respostas de terceiros.
3. Coletar evidência de produção para TLS, headers, proxy confiável, rate limit
   compartilhado, secrets, banco, logs, backup e retenção.
4. Formalizar sessão, MFA/IdP, inventário criptográfico, classificação de dados,
   logging e prazos de correção de dependências.
5. Executar DAST/pentest independente no artefato e ambiente candidatos.
6. Revalidar todos os itens após qualquer mudança material de arquitetura ou da
   versão do ASVS.
