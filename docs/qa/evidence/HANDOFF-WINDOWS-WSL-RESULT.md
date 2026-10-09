# Resultado — Prova em máquina Windows (WSL backend)

Resultado do handoff `HANDOFF-WINDOWS-WSL.md`, executado na VM Windows do Devin.

## Ambiente

| Item | Valor |
|---|---|
| OS | Windows Server 2022 (build 10.0.20348.5622) |
| WSL | 2.7.10.0, kernel 6.18.33.2-2 |
| Distros | `Ubuntu`, `Ubuntu2` (Ubuntu2 importada de export tar da Ubuntu — `wsl.exe --install` não alcançou o feed), `docker-desktop` |
| Node | 22.23.2 (`C:\nexus-tools\node-v22.23.2-win-x64`) |
| Branch | `feat/orc-outbox-command-receipts-boot-reconcile` |
| HEAD da prova | `23af79cc` (fix(orc): revoga o grant do CDP e reminta a URL na repetição) |
| Data | 2026-10-09 ~09:55–09:58 UTC |

## Tabela de evidência

| # | Prova | Resultado (passou/falhou + evidência) |
|---|---|---|
| A1 | `wsl-runtime.test.ts` no Windows | **PASSOU — 10/10** (o doc esperava 5/5; a suíte cresceu para 10 testes no HEAD atual) |
| B1 | `wsl.exe -l -q` ≥ 2 distros | **PASSOU — 3 listadas:** `Ubuntu`, `Ubuntu2`, `docker-desktop` |
| B2 | argv `-d Ubuntu --cd … exec bash -lc` roda | **PASSOU** — imprimiu `/home` e `Linux devinbox 6.18.33.2-microsoft-standard-WSL2` |
| B2b | o mesmo com a 2ª distro | **PASSOU** — `Ubuntu2` imprimiu `/home` e o mesmo kernel |
| B3 | slots `wsl:Ubuntu` ≠ `wsl:Ubuntu2`; nome com `/` recusado | **PASSOU** — `wsl:Ubuntu` ≠ `wsl:Ubuntu2`; `Ubuntu/evil` → `wsl distro name is not a safe credential slot` |
| B4 | UNC↔Linux round-trip | **PASSOU** — `\\wsl.localhost\Ubuntu\home\me\app` → `{distro:'Ubuntu', linuxPath:'/home/me/app'}` → mesmo UNC; `toLinuxPath('C:\Users\Administrator\repos')` → `/mnt/c/Users/Administrator/repos` |
| B5 | PTY em distro Ubuntu no app | **NÃO EXECUTÁVEL nesta branch** — `planWslRuntime` não tem consumidor no caminho de PTY e a UI não oferece runtime `wsl`; integração declarada fora do escopo do PR |
| B5b | troca de distro não reaproveita credencial | **NÃO EXECUTÁVEL** — depende de B5; o núcleo garante slot por distro (B3), sem superfície no app para provar |
| B6 | `host.wsl.isAvailable` / `listDistros` | **NÃO EXECUTÁVEL nesta branch** — os métodos existem só no catálogo de params RPC (`rpc-params-catalog.generated.ts`); nenhum handler no bridge |

## Conclusão

- **Núcleo WSL verificado em Windows real**: argv, execução em distro, slot de credencial por distro e UNC↔Linux — A1–B4 verdes.
- **B5/B6 continuam "prova pendente de integração"**: não é falha do núcleo — faltam o consumidor PTY e os handlers `host.wsl.*`, que o PR declara fora do escopo. Quando a integração aterrissar, estes dois itens precisam de re-handoff.

## Logs brutos

### A1 — vitest

```text
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

### B1 — `wsl.exe -l -q`

```text
Ubuntu
Ubuntu2
docker-desktop
```

### B2 — `wsl.exe -d Ubuntu --cd /home -- exec bash -lc "pwd && uname -a"`

```text
/home
Linux devinbox 6.18.33.2-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Thu Jun 18 21:54:43 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux
```

### B2b — `wsl.exe -d Ubuntu2 --cd /home -- exec bash -lc "pwd && uname -a"`

```text
/home
Linux devinbox 6.18.33.2-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Thu Jun 18 21:54:43 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux
```

### B3/B4/B2-plano — `npx tsx C:\nexus-tools\wsl-proof.mts`

```text
=== B3: credential slot per distro ===
wslCredentialSlot('Ubuntu')  -> wsl:Ubuntu
wslCredentialSlot('Ubuntu2') -> wsl:Ubuntu2
slots diferentes: true
slash rejeitado: wsl distro name is not a safe credential slot: Ubuntu/evil
=== B4: UNC <-> Linux ===
parseWslUncPath -> {"distro":"Ubuntu","linuxPath":"/home/me/app"}
toLinuxPath('C:\Users\Administrator\repos') -> /mnt/c/Users/Administrator/repos
toWindowsWslUncPath('/home/me/app','Ubuntu') -> \\wsl.localhost\Ubuntu\home\me\app
round-trip -> {"distro":"Ubuntu","linuxPath":"/home/me/app"} | linuxPath===/home/me/app: true
=== B2: planWslRuntime argv real ===
plan.argv = ["-d","Ubuntu2","--cd","/root","--exec","bash","-lc","pwd '&&' uname -a"]
linuxCwd=/root unc=\\wsl.localhost\Ubuntu2\root slot=wsl:Ubuntu2
=== isWslRuntimeUsable (host Windows, sem WSL_DISTRO_NAME) ===
{"available":true,"reason":"windows-host-listed-distro","distroSlot":"wsl:Ubuntu"}
{"available":false,"reason":"wsl-distro-name-unsafe","distroSlot":null}
```
