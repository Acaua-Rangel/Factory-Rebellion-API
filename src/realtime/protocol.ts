// Wire format shared by every realtime message: {"t": "<type>", "d": {...}}
// (ASM-005). The client sends intents; the server answers with state.
export interface Envelope {
  t: string;
  d?: unknown;
}

// WebSocket close codes in the private 4000–4999 range.
export const CLOSE = {
  INVALID_SESSION: 4001,
  REPLACED: 4002,
  TIMEOUT: 4003,
  FLOOD: 4004,
} as const;

export const ERROR = {
  BAD_MESSAGE: 'bad_message',
  NOT_AUTHENTICATED: 'not_authenticated',
  INTERNAL_ERROR: 'internal_error',
} as const;

// Returns null for anything that is not a JSON object with a string "t".
export function parseEnvelope(raw: string): Envelope | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const { t, d } = value as Record<string, unknown>;
  if (typeof t !== 'string' || t.length === 0) {
    return null;
  }
  return { t, d };
}
