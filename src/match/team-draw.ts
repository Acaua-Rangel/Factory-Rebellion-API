import { randomInt } from 'crypto';
import { DrawnPlayer, Look } from './match.types';

export interface DrawInput {
  sessionId: string;
  nickname: string;
}

// Splits a full room into two equal teams at random (AC-034), picks one Owner
// among the capatazes (the rest are Policemen) and gives the workers one of
// the two looks as evenly as possible (AC-035). Uses a CSPRNG (P-004).
export function drawTeams(
  players: DrawInput[],
  draw: (max: number) => number = (max) => randomInt(max),
): DrawnPlayer[] {
  if (players.length === 0 || players.length % 2 !== 0) {
    throw new Error('a match needs an even, non-zero number of players');
  }

  // Fisher–Yates shuffle
  const shuffled = [...players];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = draw(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const half = shuffled.length / 2;
  const workers = shuffled.slice(0, half);
  const capatazes = shuffled.slice(half);

  const looks: Look[] = ['op1', 'op2'];
  return [
    ...workers.map(
      (p, i): DrawnPlayer => ({
        ...p,
        team: 'workers',
        role: 'worker',
        look: looks[i % 2],
      }),
    ),
    // the shuffle already made the order random, so the first one is the Owner
    ...capatazes.map(
      (p, i): DrawnPlayer => ({
        ...p,
        team: 'capatazes',
        role: i === 0 ? 'owner' : 'policeman',
        look: null,
      }),
    ),
  ];
}
