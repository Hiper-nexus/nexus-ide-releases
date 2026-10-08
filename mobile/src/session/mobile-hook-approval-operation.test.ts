import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { hookApprovalResponse, respondToHookApproval } from './mobile-hook-approval-operation'

const target = { itemId: 'req-1', expectedRevision: 1, optionId: 'accept' }

function clientReplying(reply: unknown): { client: RpcClient; sendRequest: ReturnType<typeof vi.fn> } {
  const sendRequest = vi.fn().mockResolvedValue(reply)
  return { client: { sendRequest } as unknown as RpcClient, sendRequest }
}

describe('hook approval RpcOperation (PRV-02/MOB-07)', () => {
  it('is the envelope-less respondToApproval, interpreted on settle as an object', () => {
    expect(hookApprovalResponse).toMatchObject({
      method: 'agentSession.respondToApproval',
      acceptance: 'object-result-or-null',
      barrier: 'on-settle'
    })
  })

  it('sends exactly requestId/revision/decision with the chat write budget', async () => {
    const { client, sendRequest } = clientReplying({ ok: true, result: { status: 'accepted', receipt: {} } })
    await expect(respondToHookApproval(client, target, 15_000)).resolves.toBe('accepted')
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.respondToApproval',
      { itemId: 'req-1', expectedRevision: 1, optionId: 'accept' },
      { timeoutMs: 15_000, budgetSpansConnect: true }
    )
  })

  it('a host rejection, an outer refusal or a foreign reply all read as rejected', async () => {
    for (const reply of [
      { ok: true, result: { status: 'rejected', reason: 'approval-grant-required' } },
      { ok: false, error: { code: 'method_not_found', message: 'nope' } },
      { ok: true, result: { status: 'maybe' } },
      { ok: true, result: null }
    ]) {
      const { client } = clientReplying(reply)
      await expect(respondToHookApproval(client, target, 15_000)).resolves.toBe('rejected')
    }
  })

  it('an option that is not a broker decision never leaves the phone', async () => {
    const { client, sendRequest } = clientReplying({ ok: true, result: { status: 'accepted' } })
    await expect(
      respondToHookApproval(client, { ...target, optionId: 'acceptAlways' }, 15_000)
    ).resolves.toBe('rejected')
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('transport failure stays on the promise (delivery may be unknown)', async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error('socket closed'))
    await expect(
      respondToHookApproval({ sendRequest } as unknown as RpcClient, target, 15_000)
    ).rejects.toThrow('socket closed')
  })
})
