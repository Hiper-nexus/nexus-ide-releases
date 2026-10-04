# C6: fronteiras nativas e prova por adapter

Marco de fonte; não é aceite de C6 nem prova do candidato assinado.

Todo `spawnAgentSession` recebe ambiente de scheduling Main-owned, sem condição de missão/role. `claimSessionCommandProcess` exige `session.agent` e o host comprova PID/ancestralidade/nascimento. Shell humano não recebe essa autoridade. Imports leves do executável exato de IA não pegam a reserva de um comando; seus subprocessos continuam instrumentados.

| Adapter real | Imagem instalada observada (03/10) | Transporte disponível no Nexus | Prova e lacuna |
|---|---|---|---|
| Claude, GLM, GLM Flash, Longcat, DeepSeek, Muse Claude | Claude Mach-O 2.1.288 | settings privado por sessão; PreToolUse; BASH_ENV/ZDOTDIR herdados | FIFO de Bash/Zsh provado; ferramenta do CLI real ainda requer prova. NODE_OPTIONS não injeta JS em Mach-O |
| OpenClaude | catálogo bin openclaude; imagem não inspecionada | hooks da família Claude e ambiente Main | runtime não verificado |
| Codex | launcher Node → vendor nativo | config privado shell_environment_policy.set; hooks argv já existentes; Bash/Zsh | core antes retirava scheduling. Config privado agora inclui somente allowlist. Node launcher e ferramentas nativas são fronteiras distintas |
| AGY, Qwen, MiniMax Code | catálogo; runtime Node declarado pelos preparadores | ambiente e child_process Node; perfis MCP por sessão | preexec de runners, require/eval e env removida provados por Node real; exec do CLI real ainda não provado |
| Kimi | Mach-O no .kimi-code/bin/kimi | overlay KIMI_CODE_HOME; hooks flat; ambiente Main | Bash/Zsh disponível; não é prova de que todo exec usa essas shells |
| Grok | Mach-O grok-1.0.46 | overlay GROK_HOME; hooks/nexus.json; ambiente Main | PreToolUse existe na configuração; shell efetiva não provada |
| Devin | Mach-O 3000.11.3 | overlay/private MCP; ambiente Main | shell efetiva e transformação preexec não provadas |
| OpenCode | Mach-O 2.0.20 | perfil privado; ambiente Main | runtime não-Node; child_process Node não cobre exec interno |
| Muse | Mach-O 1.4.0-R4302.1 | perfil privado/env Main | shell efetiva e transformação preexec não provadas |
| MiMo Code | catálogo bin mimo; runtime tratado pelo dono MiMo | config e hooks Main por sessão | fonte de completion não equivale a admissão de tool shell |
| Aider | Python no venv uv (shebang observado) | ambiente Main; sem MCP | `aider/run_cmd.py`: pexpect seleciona SHELL; fallback subprocess usa shell=True sem executable, portanto /bin/sh. BASH_ENV/ZDOTDIR não cobrem esse fallback |

As hooks de status existentes não equivalem a uma licença física: PreToolUse ainda não tem o PID do programa pesado, e PostToolUse não prova saída de descendentes. Uma hook que modifica input poderia colocar uma admissão no mesmo shell antes do comando, mas precisa protocolo e runtime reais verificados, preservando cwd/argv. Nenhuma configuração global do operador foi modificada.

Catálogo de fonte: Node TypeScript (inclui entrada renomeada dentro do pacote e cópia standalone reconhecida por cabeçalho limitado), Vitest/Jest/Mocha, Vite/esbuild/webpack/Rollup/Forge, npm scripts/install e shell tsc/tsgo/tests/build/install/cargo/go/make/cmake/ninja/gradle/mvn. `npm --workspace/--prefix` é normalizado no entry. A prova de fixture não afirma ter instalado ou executado tsgo/go (Go não está instalado neste host).

Provas locais anteriores ao candidato: 7 arquivos/147 testes no conjunto nativo/config/host; 5 arquivos/181 testes + 8 skips no conjunto PTY/supervisor/bootstrap; typecheck completo verde. Contagens se sobrepõem. O marco posterior adiciona o fixture de Node AI root e o Seatbelt offline; consultar o relatório/commit mais recente para resultado final.

Pendências explícitas: transporte absoluto /bin/sh de agentes não-Node; cada CLI real; ambiente Windows/CIM; candidato empacotado/assinado. Nenhuma delas é suprida pelo MCP terminal_run já governado ou por uma instrução em prompt.
