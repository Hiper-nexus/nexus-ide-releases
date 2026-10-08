import { describe, expect, it } from 'vitest'
import {
  HookApprovalRespondParams,
  RespondParams,
  RespondToApprovalParams
} from './structured-agent-session-params'

const envelope = {
  sessionId: 'not-checked-here',
  clientOperationId: 'op-1',
  expectedRuntimeFence: 1,
  payloadFingerprint: 'a'.repeat(64)
}

describe('agentSession.respondToApproval params (PRV-02/MOB-07)', () => {
  it('accepts the envelope-less hook approval branch', () => {
    expect(
      RespondToApprovalParams.safeParse({ itemId: 'req-1', expectedRevision: 1, optionId: 'decline' }).success
    ).toBe(true)
  })

  it('the hook branch is strict: only broker decisions, no extra fields, positive revision', () => {
    for (const bad of [
      { itemId: 'req-1', expectedRevision: 1, optionId: 'acceptAlways' },
      { itemId: 'req-1', expectedRevision: 0, optionId: 'accept' },
      { itemId: ' req-1', expectedRevision: 1, optionId: 'accept' },
      { itemId: 'req-1', expectedRevision: 1, optionId: 'accept', paneId: 'p' }
    ]) {
      expect(HookApprovalRespondParams.safeParse(bad).success).toBe(false)
    }
  })

  it('the hook branch refuses an envelope; the structured branch is unchanged', () => {
    const structured = { envelope, itemId: 'i', expectedRevision: 1, optionId: 'accept' }
    expect(HookApprovalRespondParams.safeParse(structured).success).toBe(false)
    expect(RespondToApprovalParams.safeParse(structured).success).toBe(
      RespondParams.safeParse(structured).success
    )
    // Without an envelope the structured branch never admits it: only the hook branch can.
    const bare = { itemId: 'i', expectedRevision: 1, optionId: 'accept' }
    expect(RespondParams.safeParse(bare).success).toBe(false)
    expect(RespondToApprovalParams.safeParse(bare).success).toBe(true)
  })
})
