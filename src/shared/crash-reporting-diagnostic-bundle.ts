// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: path preserved; attribution header

export type CrashReportDiagnosticBundle =
  | {
      status: 'attached'
      bundleSubmissionId: string
      bytes: number
      spanCount: number
    }
  | {
      status: 'uploaded'
      ticketId: string
      bundleSubmissionId: string
      bytes: number
      spanCount: number
    }
  | {
      status: 'not_uploaded'
      reason: string
      bundleSubmissionId?: string
      bytes?: number
      spanCount?: number
    }

export function appendDiagnosticBundleLines(
  lines: string[],
  diagnosticBundle: CrashReportDiagnosticBundle | undefined,
  sanitizeString: (value: string) => string
): void {
  if (!diagnosticBundle) {
    return
  }
  lines.push('', 'Diagnostic log:')
  if (diagnosticBundle.status === 'attached') {
    lines.push(
      '- Status: attached',
      `- Bundle submission ID: ${sanitizeString(diagnosticBundle.bundleSubmissionId)}`,
      `- Spans: ${diagnosticBundle.spanCount}`,
      `- Bytes: ${diagnosticBundle.bytes}`
    )
    return
  }
  if (diagnosticBundle.status === 'uploaded') {
    lines.push(
      '- Status: uploaded',
      `- Ticket ID: ${sanitizeString(diagnosticBundle.ticketId)}`,
      `- Bundle submission ID: ${sanitizeString(diagnosticBundle.bundleSubmissionId)}`,
      `- Spans: ${diagnosticBundle.spanCount}`,
      `- Bytes: ${diagnosticBundle.bytes}`
    )
    return
  }
  lines.push('- Status: not uploaded', `- Reason: ${sanitizeString(diagnosticBundle.reason)}`)
  if (diagnosticBundle.bundleSubmissionId) {
    lines.push(`- Bundle submission ID: ${sanitizeString(diagnosticBundle.bundleSubmissionId)}`)
  }
  if (typeof diagnosticBundle.spanCount === 'number') {
    lines.push(`- Spans: ${diagnosticBundle.spanCount}`)
  }
  if (typeof diagnosticBundle.bytes === 'number') {
    lines.push(`- Bytes: ${diagnosticBundle.bytes}`)
  }
}
