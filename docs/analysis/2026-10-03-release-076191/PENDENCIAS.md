# Pendências da release — 04/10/2026, 21:40 BRT

Escopo integral: toda a integração pendente da Missão Terminais, F-764 completo e todas as melhorias solicitadas. Versão preparada: **0.76.192**. **Ainda não existe candidato assinado/notarizado nem publicação desta integração.**

| Etapa | Estado e trabalho restante |
|---|---|
| Integração de fonte | Entregas existentes preservadas e integradas, incluindo análise de PTY fora do Main, batches/backpressure, Git assíncrono, watchdog/profile, aviso ocupado, memória, MiMo, N1–N14 e fila pesada. Autopilot preserva rede/execução livres. Novas worktrees/candidatos `.noindex`; caminhos existentes preservados. |
| C.6 e CLIs reais | Claude/Grok/Kimi/OpenCode/Codex/Qwen/MiMo/MiniMax/Muse têm controles privados delimitados. Main caller Codex, canal por arquivos, guardian MiniMax e F901 receberam revisão independente de fonte. Muse caller aguarda revisão independente. Aider real em PTY passou no executor com confirmação única normal, aguardando importação/checagem. AGY/Devin continuam abertos: preflight de autenticação não permitiu alcançar a ferramenta real; presença de código não conta como execução aprovada. |
| Correção da fixture Codex | Gate privado exato119e67127:148 PASS/8 skips/2 FAILED. As duas falhas vieram do socket Unix longo da fixture; reprodução independente curl exit6. Correção usa caminho curto e asserts separados TCP/Unix, sem mudar política do produto. Rerun pendente. |
| Validação completa | Instalação privada nova902deps, Electron43.7.4, Node22/npm12, postinstall/rebuild:node aprovados. Falta congelar o conjunto final e executar suíte completa, tipos app/server, segurança/audit/SBOM/licenças/native e revisão final dos104 requisitos. Contagens históricas e focadas não substituem esse gate. |
| Aceite F-764 | Repetir no SHA final:15 terminais, flood ≥5MB/s, supervisor/spawn concorrentes, paridade/conclusão semântica e falha do worker; p99<100ms, máximo<1s, bloqueio de criar worker<100ms. Executar regex adversarial e preservar perfis/contexto. |
| Prova no aplicativo | Construir DMG/ZIP assinados/notarizados e executar release:candidate. Ainda faltam watchdog40s/recuperação e aviso ocupado, duas inicializações com missões/workers/handoff/ACK/recovery/movimentação/pergunta/memória/resume, imagem N7 inspecionada, voz/TCC, recursos300s, Keychain/update e quit sem órfãos. Revisões de fonte não aprovam esses fluxos físicos. |
| Publicação | Conferir novamente remoto e versão livre; tag no SHA exato validado. Publicar pelo script canônico com integração main/tag e verificar canônica/espelho, recibos, hashes, feeds e download. A tag histórica v0.76.191 permanece intacta. |

Mapa de cobertura: `.superpowers/sdd/PLAN/coverage-current-final.md`. Continuidade operacional: `.superpowers/sdd/PLAN/checkpoint-20261004-2140.md`. Nenhum item aberto foi removido para acelerar a publicação.
