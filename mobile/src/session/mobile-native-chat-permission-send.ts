import { useCallback, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS,
  sendMobileNativeChatMessageWithOutcome,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import {
  decodeApprovalResponseToken,
  type StructuredPromptResponseTarget
} from './mobile-structured-agent-prompts'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from './mobile-native-chat-terminal-write-lock'

export function sendMobileNativeChatPermissionResponse(args: {
  client: RpcClient
  terminal: string
  deviceToken: string | null
  text: string
}): Promise<MobileNativeChatSendOutcome> {
  // Why: approval choices are already complete terminal control sequences;
  // appending Return changes both numbered choices and Escape denial.
  return sendMobileNativeChatMessageWithOutcome({
    client: args.client,
    terminal: args.terminal,
    text: args.text,
    enter: false,
    ...(args.deviceToken ? { mobileClient: { id: args.deviceToken, type: 'mobile' as const } } : {})
  })
}

/** PRV-02/MOB-07: answer the host's approval broker with a decision. Never
 *  touches the PTY — a rejection (no grant on this pane, request closed) is
 *  final and must not degrade into a keystroke. */
export async function sendMobileHookApprovalResponse(args: {
  client: RpcClient
  target: StructuredPromptResponseTarget
}): Promise<MobileNativeChatSendOutcome> {
  try {
    const response = await args.client.sendRequest(
      'agentSession.respondToApproval',
      {
        itemId: args.target.itemId,
        expectedRevision: args.target.expectedRevision,
        optionId: args.target.optionId
      },
      { timeoutMs: MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS, budgetSpansConnect: true }
    )
    const result = response.ok ? (response.result as { status?: unknown } | null) : null
    return result?.status === 'accepted' ? 'accepted' : 'rejected'
  } catch (error) {
    return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
      ? 'unknown'
      : 'rejected'
  }
}

export function useMobileNativeChatPermissionSend(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  onSendError: (message: string) => void
}): (text: string) => Promise<boolean> {
  return useCallback(
    async (text: string): Promise<boolean> => {
      const target = decodeApprovalResponseToken(text)
      if (target) {
        // A decision for the host broker: no terminal, no input lease needed.
        if (!args.client) {
          args.onSendError('Response not sent (disconnected)')
          return false
        }
        const outcome = await sendMobileHookApprovalResponse({ client: args.client, target })
        if (outcome === 'unknown') {
          args.onSendError('Response unconfirmed — check chat before retrying')
        } else if (outcome === 'rejected') {
          args.onSendError('Response not accepted by the desktop')
        }
        return outcome === 'accepted'
      }
      const terminal = args.handleRef.current
      if (!args.client || !terminal || !args.enabled) {
        args.onSendError('Response not sent (disconnected)')
        return false
      }
      // A choice keystroke must not interleave into a mid-flight composed write
      // (image paste, paced answer) on the same PTY.
      if (!acquireMobileNativeChatTerminalWrite(terminal)) {
        args.onSendError('Response not sent')
        return false
      }
      // No stale-input heal here (unlike the text/ask sends): a choice is an
      // `enter: false` key for an active overlay that swallows the clear, so it
      // would consume the marker still protecting the next real message.
      let outcome: MobileNativeChatSendOutcome
      try {
        outcome = await sendMobileNativeChatPermissionResponse({
          client: args.client,
          terminal,
          deviceToken: args.deviceTokenRef.current,
          text
        })
      } finally {
        releaseMobileNativeChatTerminalWrite(terminal)
      }
      if (outcome === 'unknown') {
        // Why: the response may have been delivered (ack lost / path cutover) —
        // a definite "not sent" would invite a double answer.
        args.onSendError('Response unconfirmed — check chat before retrying')
      } else if (outcome === 'rejected') {
        args.onSendError('Response not sent')
      }
      return outcome === 'accepted'
    },
    [args.client, args.deviceTokenRef, args.enabled, args.handleRef, args.onSendError]
  )
}
