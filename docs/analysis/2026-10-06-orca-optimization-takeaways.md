# Análise Orca (stablyai/orca) — otimizações e o que foi aplicado

> 06/10/2026. Repositório MIT. O Nexus já herdou trabalho em worktrees,
> orchestrators e CLIs. Este documento cobre o que a análise de otimização
> encontrou e o que foi trazido.

## O que o Orca é

ADE (AI Development Environment) para frota de agentes paralelos: Codex,
Claude Code, OpenCode, Pi etc., cada um em worktree isolada. Desktop +
mobile + SSH remoto. A revisão de integração abaixo se limita ao código local
do Nexus; não valida popularidade nem frequência de releases do projeto externo.

## Padrões de otimização encontrados

### 1. Coalescência de sweep de memória (`memory/collector.ts`)

> "Concurrent callers coalesce onto a single in-flight sweep so a burst of
> renderer polls never produces overlapping child processes."

Chamadas concorrentes de `collectMemorySnapshot` compartilham o mesmo
promise. Evita `ps`/CIM sobrepostos quando vários consumidores perguntam
ao mesmo tempo.

**Aplicado ao Nexus:** `probePaneFootprints` em `pty-manager.ts` agora
coalesce. O broadcast de 30 s, `runtime-gates` e `perf-ipc` compartilham
um único sweep.

### 2. Timeout por progresso, não por relógio (`usage/usage-scan-worker-client.ts`)

> "Why no-progress rather than wall clock: a cold scan of a real history is
> legitimately minutes — 637 s measured on a 30 GB corpus... A wall-clock
> deadline killed those scans, recorded a scan error, and left the cache
> unadvanced."

O worker posta um contador de arquivos enquanto trabalha (`UsageScanWorkerProgress`).
O timeout só cobre o gap entre dois arquivos, não o tempo total.

**Lição para o Nexus:** espera na fila e prazo de execução são contratos
diferentes. O deadline do `HeavyCommandPermitPool` limita somente o waiter;
depois da admissão ele é removido da fila. Portanto, esse prazo não mata um
`make verify` já admitido de 10 minutos. Timeout por progresso é uma proposta
para caminhos de execução específicos, ainda não implementada nem validada;
saída no PTY, sozinha, também não prova avanço útil.

### 3. Limpeza de PTY oculto (`rate-limits/hidden-pty-cleanup.ts`)

Windows ConPTY: `destroy()` chama `kill()` de novo e fecha o handle duas
vezes. O cleanup do Orca neutraliza o `kill` pós-exit no POSIX (evita
SIGHUP em PID reusado) e pula `destroy` no Windows após kill intencional.

O Nexus tem lógica própria em `pty-descendant-termination`. `removeTreeSync`
remove arquivos e não comprova proteção contra double-close do ConPTY. Esta
comparação não adicionou um teste Windows de handles; essa afirmação exige
validação do caminho de encerramento e não deve ser tratada como prova.

### 4. Rastreio de dispatch (`agent-launch/agent-launch-not-started.ts`)

> "After the request leaves this process a failure proves nothing — an SSH
> or daemon spawn whose reply was lost may still have started."

Só falha ANTES do dispatch conta como "not started". Depois, o erro não
prova nada.

**Já coberto no Nexus** pelo `pane-start-watchdog` (F-723), que distingue
falha provada de morte tardia. Padrão equivalente.

### 5. Recibos honestos por superfície (`agent-launch/agent-launch-prompt-delivery.ts`)

`journaled` (structured session) vs `handed-to-terminal` (PTY, sem
transcript) vs `not-delivered`. O receipt nunca mente sobre o que aconteceu.

**Já coberto no Nexus** pelos recibos de spawn (`harness.source`, paste
ingest). Padrão bom de seguir em mudanças futuras.

### 6. Re-render do tab-bar (`perf(tab-bar): PR #24240`)

Scroll da faixa de abas não re-renderiza cada aba. O indicador de scroll
usa `subscribeToStripResize` em vez de receber métricas como props (que
disparavam re-render a cada scroll).

**Lição para o Nexus:** o renderer da grade de terminais pode ter o mesmo
problema com o xterm. Vale auditar quando tocar no PaneGrid.

### 7. Rate-limits por provider (`rate-limits/`)

~100 arquivos: fetchers por CLI (Claude, Codex, Cursor, Gemini, Grok,
Kimi, MiniMax, OpenCode, ZCode), classificação de janela de rate limit,
seleção de alvo por conta, orquestração de refresh.

**Nexus tem equivalente** no Redline (quota panel, cost-tracker,
`usage/`). Não é gap crítico.

## Resumo do que foi trazido

| Padrão | Status |
|--------|--------|
| Coalescência de sweep de memória | **Aplicado** em `probePaneFootprints` |
| Timeout por progresso (não wall-clock) | Lição registrada; requer calibração |
| Limpeza PTY Windows | Já coberto (F-663) |
| Dispatch tracking | Já coberto (F-723) |
| Recibos honestos | Já coberto |
| Re-render tab-bar | Lição para auditar PaneGrid |
| Rate-limits por provider | Já coberto (Redline) |
