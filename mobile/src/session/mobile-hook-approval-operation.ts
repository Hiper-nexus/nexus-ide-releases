import { z } from 'zod'
import { isApprovalDecision } from '../../../src/shared/approval-decision'
import { defineRpcOperation, runRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredPromptResponseTarget } from './mobile-structured-agent-prompts'

// PRV-02/MOB-07: the host broker's verdict on a hook approval. `accepted` carries a receipt
// (repeat answers return the same receipt); `rejected` names why (no grant on the pane, request
// closed, stale revision). Anything else is an incompatible host and reads as rejected.
const hookApprovalVerdict = rpcResultVariant(
  'hook-approval-verdict',
  z.object({
    status: z.enum(['accepted', 'rejected']),
    reason: z.string().optional()
  })
)

/**
 * `agentSession.respondToApproval` for an approval the host's hook broker holds — the
 * envelope-less branch of the contract. An outer refusal (unknown method on an older host,
 * `not authorized`) is null, never a throw; a transport failure stays on the promise so the
 * caller can tell delivery-unknown from a definite refusal.
 */
export const hookApprovalResponse = defineRpcOperation({
  name: 'agentSession.respond-hook-approval',
  method: 'agentSession.respondToApproval',
  acceptance: 'object-result-or-null',
  barrier: 'on-settle',
  read: hookApprovalVerdict
})

/** Sends one decision. A target whose option is not a broker decision never leaves the phone.
 *  The budget spans the reconnect wait, like every interactive chat write. */
export async function respondToHookApproval(
  client: RpcClient,
  target: StructuredPromptResponseTarget,
  timeoutMs: number
): Promise<'accepted' | 'rejected'> {
  if (!isApprovalDecision(target.optionId)) {
    return 'rejected'
  }
  const verdict = await runRpcOperation(
    client,
    hookApprovalResponse,
    {
      itemId: target.itemId,
      expectedRevision: target.expectedRevision,
      optionId: target.optionId
    },
    { timeoutMs, budgetSpansConnect: true }
  )
  return verdict?.status === 'accepted' ? 'accepted' : 'rejected'
}
