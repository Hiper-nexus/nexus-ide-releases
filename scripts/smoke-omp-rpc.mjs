#!/usr/bin/env node

/**
 * Smoke local e sem prompt do contrato rpc-ui suportado pelo Nexus.
 *
 * O HOME, o workspace e as sessões vivem num diretório temporário; nenhuma
 * credencial real é herdada. A chave sintética só torna um modelo do catálogo
 * local elegível para o get_state — nenhum prompt é enviado ao provider.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OmpRpcSession,
  resolveOmpBin,
  waitForOmpSessionReady,
} from '../src/main/adapters/omp-rpc-service.ts';

const root = await mkdtemp(path.join(tmpdir(), 'nexus-omp-rpc-smoke-'));
let session = null;

try {
  const home = path.join(root, 'home');
  const workspaceRoot = path.join(root, 'workspace');
  const sessionDir = path.join(root, 'sessions');
  await Promise.all([
    mkdir(home),
    mkdir(workspaceRoot),
    mkdir(sessionDir),
  ]);

  const resolved = await resolveOmpBin(
    process.env.NEXUS_OMP_BIN?.trim() || 'omp',
  );
  const notices = [];
  session = new OmpRpcSession(
    {
      sessionId: randomUUID(),
      workspaceRoot,
      approvalPolicy: 'safe',
      binPath: resolved.binPath,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TMPDIR: root,
        PI_CODING_AGENT_DIR: sessionDir,
        // Valor deliberadamente inválido e nunca enviado: não há prompt.
        OPENAI_API_KEY: 'nexus-rpc-smoke-never-sent',
        NO_COLOR: '1',
      },
    },
    {
      hostTools: [
        {
          name: 'nexus_rpc_smoke_readonly',
          description: 'Ferramenta inerte usada apenas no handshake local.',
          parameters: { type: 'object', properties: {} },
        },
      ],
      dispatchHostTool: async () => ({
        ok: false,
        error: 'smoke RPC local não despacha tools',
      }),
      auditAutoApproval: () => {},
      onPush: (event) => {
        if (event.kind === 'notice') notices.push(event.message);
      },
      requestTimeoutMs: 8_000,
    },
  );

  await waitForOmpSessionReady(session, 15_000, 25);
  const snapshot = session.snapshot();
  if (snapshot.state !== 'idle') {
    throw new Error(`estado final inesperado: ${snapshot.state}`);
  }
  if (!snapshot.model?.provider || !snapshot.model.id) {
    throw new Error('get_state não retornou a identidade do modelo local');
  }
  if (notices.length > 0) {
    throw new Error(`OMP publicou aviso durante o bootstrap: ${notices[0]}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      version: resolved.version,
      state: snapshot.state,
      model: snapshot.model,
      promptSent: false,
      realCredentialInherited: false,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `[smoke:omp-rpc] ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
} finally {
  session?.dispose();
  await rm(root, { recursive: true, force: true });
}
