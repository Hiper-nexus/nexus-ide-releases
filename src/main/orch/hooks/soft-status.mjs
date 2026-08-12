#!/bin/sh
':' //# ; exec process.execPath "$0" "$@"
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
const gateDir = "~/.nexus/hooks"
// Grok emits snake_case event names (env + hookEventName); Gemini has its own event names;
// Claude/Codex emit PascalCase. Everything normalizes to the Claude vocabulary.
const EVENT_ALIASES = { session_start: 'SessionStart', user_prompt_submit: 'UserPromptSubmit', pre_tool_use: 'PreToolUse', post_tool_use: 'PostToolUse', permission_request: 'PermissionRequest', stop: 'Stop', notification: 'Notification', BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse' }
const canonicalEvent = (e) => EVENT_ALIASES[String(e || '')] || String(e || '')
// Interactive tools that park the agent waiting for a human answer (Claude PreToolUse docs).
const ASK_TOOLS = ['AskUserQuestion', 'ExitPlanMode', 'ask_user_question', 'request_user_input']
// Claude Notification matchers that mean "needs human now" (NOT idle_prompt / auth_success).
// Bare "approval" is intentionally NOT matched — too broad (false amber under bypass, F-249).
const WAITING_NOTIF_TYPES = ['permission_prompt', 'agent_needs_input', 'elicitation_dialog', 'ToolPermission']
const WAITING_MSG_RE = /ToolPermission|permission_prompt|agent_needs_input|elicitation_dialog|permission needed|needs your permission|waiting for your input|Requesting permission|Do you want to proceed/i
let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  let input = {}
  try { input = JSON.parse(raw) } catch (e) {}
  const event = canonicalEvent(process.env.GROK_HOOK_EVENT || input.hook_event_name || input.hookEventName)
  const tool = String(input.tool_name || input.toolName || '')
  const sid = String(input.session_id || input.sessionId || process.env.GROK_SESSION_ID || process.env.GEMINI_SESSION_ID || '')
  // Prefer pane id; fall back to session key when the CLI sanitizes env (gemini).
  const paneId = process.env.NEXUS_PANE_ID || ''
  if (!paneId && !sid) process.exit(0)
  const waitingMarker = paneId
    ? join(gateDir, 'soft-waiting-' + paneId)
    : join(gateDir, 'soft-waiting-session-' + sid)
  const sessionMarker = paneId
    ? join(gateDir, 'soft-session-' + paneId)
    : join(gateDir, 'soft-session-session-' + sid)
  const setWaiting = () => { try { writeFileSync(waitingMarker, String(Date.now())) } catch (e) {} }
  const clearWaiting = () => { try { unlinkSync(waitingMarker) } catch (e) {} }
  if (event === 'SessionStart') {
    if (sid) { try { writeFileSync(sessionMarker, sid) } catch (e) {} }
  } else if (event === 'PreToolUse') {
    // SET only — never clear on non-ask PreToolUse (parallel tool batches race-clear).
    if (ASK_TOOLS.indexOf(tool) !== -1) setWaiting()
  } else if (event === 'PermissionRequest') {
    // Claude/Codex first-class: permission dialog is about to be shown.
    setWaiting()
  } else if (event === 'PostToolUse' || event === 'UserPromptSubmit' || event === 'Stop') {
    clearWaiting()
  } else if (event === 'Notification') {
    const ntype = String(input.notification_type || input.notificationType || '')
    const msg = String(input.message || '')
    if (WAITING_NOTIF_TYPES.indexOf(ntype) !== -1) setWaiting()
    else if (WAITING_MSG_RE.test(ntype + ' ' + msg)) setWaiting()
  }
  process.exit(0)
})
