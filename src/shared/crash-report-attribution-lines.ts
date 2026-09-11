// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: none (React boundary attribution lines)

// Type-only, so this erases at compile time and creates no import cycle.
import type { CrashReportDetailValue } from './crash-reporting'
import {
  CRASH_REPORT_ATTRIBUTION_DETAIL_KEY,
  CRASH_REPORT_ATTRIBUTION_NOTE_DETAIL_KEY,
  UNRELIABLE_BOUNDARY_ATTRIBUTION
} from './react-update-depth-attribution'

/** Promotes the attribution caveat above the details blob so a triager cannot scroll past it. */
export function appendBoundaryAttributionLines(
  lines: string[],
  details: Record<string, CrashReportDetailValue>
): void {
  if (details[CRASH_REPORT_ATTRIBUTION_DETAIL_KEY] !== UNRELIABLE_BOUNDARY_ATTRIBUTION) {
    return
  }
  const note = details[CRASH_REPORT_ATTRIBUTION_NOTE_DETAIL_KEY]
  lines.push('', `Attribution: ${UNRELIABLE_BOUNDARY_ATTRIBUTION}`)
  if (typeof note === 'string' && note) {
    lines.push(note)
  }
}
