import {
  ROOM_CODE_ALPHABET,
  generateRoomCode,
  normalizeRoomCode,
} from './room-code';

describe('Room codes', () => {
  it('AC-018: codes follow XXXX-XXXX and use only the allowed alphabet @spec:AC-018', () => {
    for (let i = 0; i < 10_000; i++) {
      const code = generateRoomCode(() => false);

      expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
      for (const letter of code.replace('-', '')) {
        expect(ROOM_CODE_ALPHABET).toContain(letter);
      }
    }
  });

  it('AC-018: the alphabet drops I and O so codes are easy to read out @spec:AC-018', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(24);
    expect(ROOM_CODE_ALPHABET).not.toContain('I');
    expect(ROOM_CODE_ALPHABET).not.toContain('O');
  });

  it('AC-018: a code that is still active is never handed out again @spec:AC-018', () => {
    const taken = new Set(['AAAA-AAAA']);
    // first 8 draws give AAAA-AAAA (index 0), the next 8 give BBBB-BBBB
    let draws = 0;
    const randomInt = () => (draws++ < 8 ? 0 : 1);

    const code = generateRoomCode((c) => taken.has(c), randomInt);

    expect(code).toBe('BBBB-BBBB');
  });

  it('AC-018: gives up instead of looping forever when every draw collides @spec:AC-018', () => {
    expect(() => generateRoomCode(() => true)).toThrow();
  });

  it.each([
    ['abcd-efgh', 'ABCD-EFGH'],
    ['ABCDEFGH', 'ABCD-EFGH'],
    ['abcdefgh', 'ABCD-EFGH'],
    ['  abcd efgh  ', 'ABCD-EFGH'],
    ['ABCD_EFGH', 'ABCD-EFGH'],
  ])('AC-022: "%s" is understood as %s @spec:AC-022', (typed, expected) => {
    expect(normalizeRoomCode(typed)).toBe(expected);
  });

  it.each(['', 'ABC', 'ABCD-EFG', 'ABCD-EFGHJ', 'ABCD-EFG1', 'IIII-OOOO', 12345])(
    'AC-022: "%s" is not a room code @spec:AC-022',
    (typed) => {
      expect(normalizeRoomCode(typed as string)).toBeNull();
    },
  );
});
