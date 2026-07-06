# Changelog

## 0.7.0 — Squad CLI sync

Data: 2026-07-06

Release focada em deixar squads, providers e contas previsíveis.

### Melhorias

- AGY substitui Gemini CLI nos defaults, built-ins, squads, roteamento e remote spawn.
- Orquestrador de squad permanece no Claude; workers são distribuídos entre as CLIs instaladas.
- Providers iniciam em modo hands-free por padrão: YOLO quando suportado, senão Bypass.
- Contas novas passam a ser ativadas imediatamente.
- Contas Claude por assinatura restauram a credencial salva no Keychain antes de marcar “em uso”.
- Tela de contas mostra login local, conta em uso, cooldown, credencial ausente e ação de sincronizar.
- Review de squad foi reorganizado para evitar texto sobreposto e melhorar leitura dos controles.
- Workers Codex, AGY, Kimi e Grok preservam o `HOME` real do Mac, mantendo logins locais sincronizados dentro dos panes.
- Skills instaladas agora são espelhadas para os namespaces de Claude, Codex, AGY, Kimi e Grok; o Nexus também cria a skill `ponytail` a partir da regra interna.

### Compatibilidade

- Squads antigos com `providerId: gemini-cli` passam a normalizar para `agy` quando `cli` não está explícito.

### Correções

- AGY usa `--dangerously-skip-permissions` como modo hands-free; `--yolo` não existe na CLI instalada e fazia o pane sair em `code 2`.
