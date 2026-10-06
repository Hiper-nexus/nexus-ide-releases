# Trial Activation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for implementation and review.

**Goal:** Oferecer teste com 6 agentes e medir adoção real sem conteúdo dos projetos.
**Architecture:** Coletor Main com dependências injetáveis e eventos locais existentes; API autenticada grava presença e dias; painel administrativo apresenta métricas com definição explícita.
**Tech Stack:** Electron/TypeScript, Hono/Zod/D1, Vite/JS. Sem dependências novas.
**Spec:** docs/superpowers/specs/2026-10-05-trial-activation-design.md

## Global Constraints
- Nenhum código, prompt, token, nome/caminho de projeto ou id de missão enviado.
- Não contar pedido de spawn como execução nem login como presença.
- API usa relógio do servidor; eventos do app são autodeclarados, não auditoria de entregas.
- Preservar mudanças alheias; não fazer deploy, push ou apagar worktrees.

### Task 1: Oferta
- [x] Alterar configuração/defaults para 6; textos Pro ilimitado no site, app e e-mails.
- [x] Validar API/site, typecheck e testes focados.

### Task 2: API
- [x] Criar migração 0009 e módulo activity com testes de auth, minimização, idempotência, retenção e métricas.
- [x] Montar rotas nativas e admin; rodar suíte e typecheck cloud-api.

### Task 3: Main e painel
- [x] Testar coletor com auth/account switching, concorrência, falhas e relógio.
- [x] Ligar presença, inventário real PTY/ACP e missão concluída; parar no shutdown.
- [x] Painel com métricas, definições, atualizações visíveis; documentar privacidade e retenção.
- [x] Testes focados, typecheck, renderer sinks, suíte/build do site.

### Task 4: Revisão
- [x] Revisão independente de diff e testes; corrigir achados e repetir verificações afetadas.

Ruling: revalidar a suíte completa em checkout limpo com dependências do lock; o checkout de desenvolvimento resolve braces do node_modules em vez do pacote local exigido pelo gate. Evidências alheias não rastreadas ficam preservadas. Publicação ainda exige gate do artefato assinado.
