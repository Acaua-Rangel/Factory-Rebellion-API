import { MatchPhase, MatchView } from './match-state';
import { PlayerStatus } from './match.types';
import { Animation } from './physics';
import { Score } from './scoring';
import { Simulation } from './simulation';

export interface SnapshotPlayer {
  id: string;
  x: number;
  y: number;
  // facing: 1 right, -1 left
  xs: 1 | -1;
  anim: Animation;
  life: number;
  status: PlayerStatus;
}

// The state of the world sent 20 times a second to every player (AC-059).
export interface Snapshot {
  // server frame number
  tick: number;
  phase: MatchPhase;
  round: number;
  suddenDeath: boolean;
  timeLeftMs: number | null;
  score: Score;
  players: SnapshotPlayer[];
  // filled in by combat
  bullets: never[];
  machines: { id: string; broken: boolean }[];
}

// A snapshot plus the number of the last input the server applied for the
// player it is sent to (AC-060).
export interface PlayerSnapshot extends Snapshot {
  ack: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Public information only: ids and nicknames never include a token (P-005).
export function buildSnapshot(view: MatchView, sim: Simulation): Snapshot {
  return {
    tick: sim.frame,
    phase: view.phase,
    round: view.round,
    suddenDeath: view.suddenDeath,
    timeLeftMs: view.timeLeftMs,
    score: { ...view.score },
    players: view.players.map((player): SnapshotPlayer => {
      const body = sim.bodyOf(player.sessionId);
      return {
        id: player.sessionId,
        x: round2(body?.x ?? player.position.x),
        y: round2(body?.y ?? player.position.y),
        xs: body?.facing ?? 1,
        anim: sim.animationOf(player.sessionId),
        life: player.life,
        status: player.status,
      };
    }),
    bullets: [],
    machines: view.machines.map((m) => ({ ...m })),
  };
}

export function forPlayer(
  snapshot: Snapshot,
  sim: Simulation,
  sessionId: string,
): PlayerSnapshot {
  return { ...snapshot, ack: sim.ackOf(sessionId) };
}
