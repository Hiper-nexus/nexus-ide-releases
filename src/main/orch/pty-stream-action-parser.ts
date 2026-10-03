import { z } from 'zod';
import { extractJsonObject } from './legacy-handoff';
const schema = z.object({ id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/u), tool: z.string().min(1).max(128).regex(/^nexus_[a-z0-9_]+$/u), args: z.record(z.string(), z.unknown()) }).strict();
export type ParsedPtyStreamAction = z.infer<typeof schema>;
/** Lossless bounded action framing; authorization and execution stay Main. */
export class PtyStreamActionParser {
  #pending = ''; #collecting: string | null = null;
  constructor(private readonly channelId: string) {}
  feed(text: string): ParsedPtyStreamAction[] {
    const found: ParsedPtyStreamAction[] = [];
    let input = text;
    for (;;) {
      if (this.#collecting !== null) {
        const body = this.#collecting + input;
        const value = extractJsonObject(body);
        if (value) {
          this.#collecting = null;
          const parsed = schema.safeParse(value.value); if (parsed.success) found.push(parsed.data);
          input = body.slice(value.end); continue;
        }
        if (body.length > 256 * 1024) { this.#collecting = null; input = body.slice(-256 * 1024); continue; }
        this.#collecting = body; return found;
      }
      const buffered = this.#pending + input;
      const marker = `### NEXUS_ACTION v1 ${this.channelId}`;
      const start = buffered.indexOf(marker);
      if (start < 0) { this.#pending = buffered.slice(-(marker.length - 1)); return found; }
      this.#pending = ''; this.#collecting = ''; input = buffered.slice(start + marker.length);
    }
  }
}
