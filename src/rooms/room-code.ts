import { randomInt } from 'crypto';

// A–Z without I and O (easy to confuse with 1 and 0 when read out loud): 24
// letters, 24^8 ≈ 1.1·10^11 codes (ASM-007).
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const MAX_ATTEMPTS = 100;

// Draws XXXX-XXXX codes with a CSPRNG (P-004) until one is not in use.
export function generateRoomCode(
  isTaken: (code: string) => boolean,
  draw: (max: number) => number = (max) => randomInt(max),
): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let letters = '';
    for (let i = 0; i < 8; i++) {
      letters += ROOM_CODE_ALPHABET[draw(ROOM_CODE_ALPHABET.length)];
    }
    const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
    if (!isTaken(code)) {
      return code;
    }
  }
  throw new Error('could not find a free room code');
}

// Players type codes by hand: accept any case and any separator (or none).
// Returns the canonical XXXX-XXXX form, or null if it cannot be a room code.
export function normalizeRoomCode(typed: unknown): string | null {
  if (typeof typed !== 'string') {
    return null;
  }
  const letters = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!new RegExp(`^[${ROOM_CODE_ALPHABET}]{8}$`).test(letters)) {
    return null;
  }
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}
