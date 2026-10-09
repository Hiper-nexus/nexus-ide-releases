# Handoff — Prova em máquina Windows (WSL backend)

**De:** sessão macOS (sem Windows/Xcode/aparelho)  
**Para:** máquina Windows com WSL instalado  
**Branch:** `feat/orc-outbox-command-receipts-boot-reconcile`  
**PR:** https://github.com/Hiper-nexus/nexus-ide/pull/126  
**HEAD para provar:** `4407b2a4d` (ou o mais novo da branch)

---

## Por que este handoff

O código do **backend WSL**, do **CdpRelay** e do **editor** está completo e testado no macOS (42/42). O que não se prova aqui:

1. **WSL runtime ponta a ponta** — argv do `wsl.exe`, execução em distro, slot de credencial por distro, caminho UNC↔Linux **reais**.
2. **PTY em distro** — o Electron/`node-pty` abrindo shell dentro de uma distro WSL.
3. **RPC `host.wsl.*`** — `isAvailable` / `listDistros` contra o `wsl.exe` de verdade.

Isto **não** precisa de Xcode nem de celular — só de **Windows + WSL**.

---

## Pré-requisitos na máquina Windows

| Item | Valor |
|---|---|
| OS | Windows 10/11 com WSL2 |
| Pelo menos 2 distros | ex.: `Ubuntu`, `Debian` (para provar o slot de credencial por distro) |
| Node | `>=22.12 <23` (engines do repo) |
| Repo | `git clone` + `git checkout feat/orc-outbox-command-receipts-boot-reconcile` |
| Dependências | `npm install` (depois `npm rebuild better-sqlite3` se o Node for diferente do instalado) |

---

## O que provar (checklist)

### A. Núcleo puro já testado — re-executar no Windows (deve continuar verde)

```powershell
npx vitest run src/main/remote/wsl-runtime.test.ts
```

Esperado: **5/5 verdes** (argv `-d`/`--cd`/`--`/`exec bash -lc`, slot `wsl:<distro>`, UNC↔Linux).

### B. WSL real — o coração deste handoff

1. **Listar distros** (prova `wsl.exe -l -q`):

   ```powershell
   wsl.exe -l -q
   ```

   Esperado: pelo menos duas distros, ex. `Ubuntu` e `Debian`. Anote os nomes **exatos**.

2. **Plano de execução** — rodar um comando dentro da distro pelo argv que `planWslRuntime` monta:

   ```powershell
   wsl.exe -d Ubuntu --cd /home -- exec bash -lc "pwd && uname -a"
   ```

   Esperado: imprime o cwd Linux e o kernel. Repetir com a segunda distro (`-d Debian`).

3. **Slot de credencial por distro** — `wslCredentialSlot('Ubuntu')` → `wsl:Ubuntu`, `wslCredentialSlot('Debian')` → `wsl:Debian`. Conferir que as duas distros produzem slots **diferentes** e que um nome com `/` é recusado.

4. **Caminho UNC↔Linux** — de dentro do Windows:

   ```powershell
   wsl.exe -d Ubuntu -- exec bash -lc "ls /mnt/c"
   ```

   E no Node via tsx (`npx tsx`; o `require` do Node não carrega `.ts`):

   ```js
   const { parseWslUncPath, toLinuxPath, toWindowsWslUncPath } = await import('./src/shared/wsl-paths.ts');
   parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\app');
   // → { distro: 'Ubuntu', linuxPath: '/home/me/app' }
   toWindowsWslUncPath('/home/me/app', 'Ubuntu');
   // → '\\\\wsl.localhost\\Ubuntu\\home\\me\\app'
   ```

5. **PTY em distro** (só no app Electron):
   - Abrir o Nexus (`npm start`).
   - Abrir um pane de terminal com runtime `wsl` / distro `Ubuntu`.
   - Esperado: o shell entra na distro (`uname -a` mostra Linux, `pwd` mostra caminho `/home/...` ou `/mnt/c/...`).
   - Trocar para `Debian` e conferir que a sessão **não** reutiliza o slot de credencial de `Ubuntu`.

6. **RPC `host.wsl.*`** (ponte mobile/web ↔ desktop):
   - `host.wsl.isAvailable` → `true`.
   - `host.wsl.listDistros` → a lista real das distros instaladas.

### C. Fora do escopo deste handoff (não precisa nesta máquina)

- Mobile em aparelho (WS nativo, Keychain, câmera, Tailscale) — exige Mac/Xcode/aparelho.
- Ditado no host — exige transcritor.

---

## O que reportar de volta

Preencher e devolver (ou abrir item F-105x):

| # | Prova | Resultado (passou/falhou + evidência) |
|---|---|---|
| A1 | `wsl-runtime.test.ts` 5/5 | |
| B1 | `wsl.exe -l -q` ≥ 2 distros | |
| B2 | argv `-d Ubuntu --cd … exec bash -lc` roda | |
| B2b | o mesmo com a 2ª distro | |
| B3 | slots `wsl:Ubuntu` ≠ `wsl:Debian`; nome com `/` recusado | |
| B4 | UNC↔Linux round-trip | |
| B5 | PTY em distro Ubuntu no app | |
| B5b | troca de distro não reaproveita credencial | |
| B6 | `host.wsl.isAvailable` / `listDistros` | |

**Falhas esperadas possíveis (não são bug do código):**
- `better-sqlite3` com `NODE_MODULE_VERSION` errado → `npm rebuild better-sqlite3`.
- Distro com nome fora de `[A-Za-z0-9._-]` → o slot é recusado **de propósito** (F-1041).

---

## Código de referência (já no PR)

| Peça | Arquivo |
|---|---|
| Núcleo WSL (argv, slot, UNC) | `src/main/remote/wsl-runtime.ts` |
| Caminhos WSL | `src/shared/wsl-paths.ts` |
| Detecção de presença | `src/main/remote/wsl-detect.ts` |
| Testes do núcleo | `src/main/remote/wsl-runtime.test.ts` |
| RPC | `src/shared/rpc-contract/` (`host.wsl.isAvailable`, `host.wsl.listDistros`) |

Nada aqui reescreve o design: é a prova do que já está no PR #126.
