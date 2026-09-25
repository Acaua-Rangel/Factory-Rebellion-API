import { Team } from './match.types';

export interface RoundFacts {
  machinesTotal: number;
  machinesBroken: number;
  // may go below zero on the tick that crosses it
  timeLeftMs: number;
  // workers still on their feet / workers incapacitated (spectators count as neither)
  workersActive: number;
  workersDown: number;
}

// Who won the round, or null while it is still open (AC-037, AC-038, AC-039).
export function roundWinner(facts: RoundFacts): Team | null {
  // Breaking the last machine comes first: it wins even if the last worker
  // went down in the same instant (ASM-031).
  if (facts.machinesTotal > 0 && facts.machinesBroken >= facts.machinesTotal) {
    return 'workers';
  }
  if (facts.workersActive === 0 && facts.workersDown > 0) {
    return 'capatazes';
  }
  if (facts.timeLeftMs <= 0) {
    return 'capatazes';
  }
  return null;
}

export interface Score {
  workers: number;
  capatazes: number;
}

export type MatchOutcome =
  | { kind: 'continue' }
  | { kind: 'winner'; team: Team }
  | { kind: 'sudden_death' };

// Checked after every round: a 2-point lead wins (AC-041); with no lead once
// the room's round limit is played, it goes to sudden death (AC-042).
export function matchOutcome(
  score: Score,
  roundsPlayed: number,
  roundLimit: number,
): MatchOutcome {
  const lead = score.workers - score.capatazes;
  if (Math.abs(lead) >= 2) {
    return { kind: 'winner', team: lead > 0 ? 'workers' : 'capatazes' };
  }
  if (roundsPlayed >= roundLimit) {
    return { kind: 'sudden_death' };
  }
  return { kind: 'continue' };
}
