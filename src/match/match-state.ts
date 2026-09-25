import { loadMap } from './map';
import { Motion } from './simulation';
import { drawTeams } from './team-draw';
import { MatchPlayer, Point, Team } from './match.types';
import { Seat, seatOf, takeSeat } from './replacement';
import { Score, matchOutcome, roundWinner } from './scoring';
import { suddenDeathOutcome } from './sudden-death';
import { walkoverWinner } from './walkover';

export const ROUND_MS = 60_000;
export const INTERMISSION_MS = 5_000; // ASM-014
export const RESULT_MS = 10_000; // ASM-014
export const START_MS = 3_000; // lets clients load the game screen (ASM-032)
export const MAX_LIFE = 6;
export const REVIVE_LIFE = 2; // a revived player comes back with 1 heart

export interface MatchMap {
  spawns: Record<Team, Point[]>;
  machineIds: string[];
}

// Spawns and machines of the room exported from GameMaker (scripts/export-map.ts).
export const DEFAULT_MAP: MatchMap = {
  spawns: loadMap().spawns,
  machineIds: loadMap().machines.map((machine) => machine.id),
};

// starting = countdown before round 1 · round = normal 60 s round ·
// intermission = 5 s break showing the result · sudden_death = no clock,
// elimination only · finished = result screen until the match closes
export type MatchPhase =
  | 'starting'
  | 'round'
  | 'intermission'
  | 'sudden_death'
  | 'finished';

export interface MatchOptions {
  roomCode: string;
  players: { sessionId: string; nickname: string }[];
  // rounds played before sudden death (the room setting, 4–6)
  rounds: number;
  map: MatchMap;
  draw?: (max: number) => number;
}

export type MatchEvent =
  | { type: 'round_started'; round: number | null; suddenDeath: boolean }
  | {
      type: 'round_ended';
      winner: Team;
      reason: 'machines' | 'clock' | 'workers_down';
      score: Score;
      roundsPlayed: number;
    }
  | { type: 'sudden_death' }
  | { type: 'sudden_death_tie' }
  | {
      type: 'match_ended';
      winner: Team;
      reason: 'score' | 'sudden_death' | 'walkover';
      score: Score;
    }
  | { type: 'player_joined'; player: MatchPlayer }
  | { type: 'player_left'; sessionId: string }
  | { type: 'closed' };

export interface MatchView {
  roomCode: string;
  phase: MatchPhase;
  // number of the current round (the last one played, during a break)
  round: number;
  roundsPlayed: number;
  roundLimit: number;
  suddenDeath: boolean;
  score: Score;
  // round clock, or the break/result countdown; null in sudden death
  timeLeftMs: number | null;
  players: MatchPlayer[];
  machines: { id: string; broken: boolean }[];
  result: {
    winner: Team;
    reason: 'score' | 'sudden_death' | 'walkover';
  } | null;
}

// The rules of one match, with no timers and no sockets: whoever drives it
// calls tick() with the elapsed time. Things that happen (machines broken,
// players down, players coming and going) only change state; who won is
// decided once per tick, so two players falling in the same tick are seen
// together (AC-066).
export class Match {
  private phase: MatchPhase = 'starting';
  private timeLeftMs: number | null = START_MS;
  private readonly score: Score = { workers: 0, capatazes: 0 };
  private roundsPlayed = 0;
  private afterBreak: 'round' | 'sudden_death' = 'round';
  private result: MatchView['result'] = null;
  private closed = false;

  private players: MatchPlayer[];
  private readonly machines = new Map<string, boolean>();
  private readonly openSeats: Seat[] = [];
  private pending: MatchEvent[] = [];

  private readonly roomCode: string;
  private readonly roundLimit: number;
  private readonly map: MatchMap;

  constructor(options: MatchOptions) {
    this.roomCode = options.roomCode;
    this.roundLimit = options.rounds;
    this.map = options.map;
    this.players = drawTeams(options.players, options.draw).map((p) => ({
      ...p,
      status: 'active',
      life: MAX_LIFE,
      position: { x: 0, y: 0 },
    }));
    this.resetRound();
  }

  view(): MatchView {
    return {
      roomCode: this.roomCode,
      phase: this.phase,
      round: this.phase === 'round' ? this.roundsPlayed + 1 : this.roundsPlayed,
      roundsPlayed: this.roundsPlayed,
      roundLimit: this.roundLimit,
      suddenDeath: this.phase === 'sudden_death',
      score: { ...this.score },
      timeLeftMs: this.timeLeftMs,
      players: this.players.map((p) => ({ ...p, position: { ...p.position } })),
      machines: [...this.machines].map(([id, broken]) => ({ id, broken })),
      result: this.result && { ...this.result },
    };
  }

  // ---- read by the game loop every frame ------------------------------------

  get roomCodeOf(): string {
    return this.roomCode;
  }

  playerIds(): string[] {
    return this.players.map((p) => p.sessionId);
  }

  // Only while a round is on can players move and snapshots matter.
  get playing(): boolean {
    return this.phase === 'round' || this.phase === 'sudden_death';
  }

  // Can this player move right now? Only while a round is on and they are on
  // their feet (down, watching and between-round players stay put).
  canMove(sessionId: string): boolean {
    if (this.phase !== 'round' && this.phase !== 'sudden_death') {
      return false;
    }
    return (
      this.players.find((p) => p.sessionId === sessionId)?.status === 'active'
    );
  }

  // What the physics should do with a player this frame: follow their inputs,
  // let a downed player fall to the ground, or keep everybody still.
  motionOf(sessionId: string): Motion {
    if (!this.playing) {
      return 'frozen';
    }
    const status = this.players.find((p) => p.sessionId === sessionId)?.status;
    if (status === 'active') {
      return 'move';
    }
    return status === 'incapacitated' || status === 'eliminated'
      ? 'fall'
      : 'frozen';
  }

  // The players as the game loop needs them, without copying (do not modify).
  roster(): readonly MatchPlayer[] {
    return this.players;
  }

  // The simulation moved a player: keep the match's view of the world in sync.
  setPosition(sessionId: string, x: number, y: number): void {
    const player = this.players.find((p) => p.sessionId === sessionId);
    if (player) {
      player.position = { x, y };
    }
  }

  // ---- things that happen (state only; resolved by the next tick) ----------

  machineBroken(machineId: string): void {
    if (this.phase === 'round' && this.machines.get(machineId) === false) {
      this.machines.set(machineId, true);
    }
  }

  // A player's life reached zero: incapacitated until the next round, or
  // eliminated for good in sudden death (AC-043).
  playerDown(sessionId: string): void {
    if (this.phase !== 'round' && this.phase !== 'sudden_death') {
      return;
    }
    const player = this.players.find((p) => p.sessionId === sessionId);
    if (player?.status !== 'active') {
      return;
    }
    player.life = 0;
    player.status =
      this.phase === 'sudden_death' ? 'eliminated' : 'incapacitated';
  }

  // Takes half-hearts of life. At zero the player goes down: incapacitated
  // until the next round, or eliminated for good in sudden death (AC-052,
  // AC-043). Someone already down, watching, or a hit outside a round changes
  // nothing.
  damage(sessionId: string, halfHearts: number): void {
    if (!this.playing || !(halfHearts > 0)) {
      return;
    }
    const player = this.players.find((p) => p.sessionId === sessionId);
    if (player?.status !== 'active') {
      return;
    }
    player.life = Math.max(0, player.life - halfHearts);
    if (player.life === 0) {
      player.status =
        this.phase === 'sudden_death' ? 'eliminated' : 'incapacitated';
    }
  }

  // A teammate got a downed player back up: 1 heart (2 half-hearts). Only in a
  // normal round: in sudden death the eliminated stay out (AC-069, AC-071).
  revive(sessionId: string): boolean {
    if (this.phase !== 'round') {
      return false;
    }
    const player = this.players.find((p) => p.sessionId === sessionId);
    if (player?.status !== 'incapacitated') {
      return false;
    }
    player.status = 'active';
    player.life = REVIVE_LIFE;
    return true;
  }

  removePlayer(sessionId: string): void {
    if (this.phase === 'finished') {
      return;
    }
    const index = this.players.findIndex((p) => p.sessionId === sessionId);
    if (index < 0) {
      return;
    }
    const [player] = this.players.splice(index, 1);
    this.openSeats.push(seatOf(player));
    this.pending.push({ type: 'player_left', sessionId });
  }

  // A newcomer takes the seat that has been open the longest and watches until
  // the next round starts (AC-072, ASM-027).
  addPlayer(sessionId: string, nickname: string): boolean {
    if (
      this.phase === 'finished' ||
      this.players.some((p) => p.sessionId === sessionId)
    ) {
      return false;
    }
    const seat = takeSeat(this.openSeats);
    if (!seat) {
      return false;
    }
    const player: MatchPlayer = {
      sessionId,
      nickname,
      ...seat,
      status: 'spectating',
      life: MAX_LIFE,
      position: this.spawn(seat.team, this.teamOf(seat.team).length),
    };
    this.players.push(player);
    this.pending.push({
      type: 'player_joined',
      player: { ...player, position: { ...player.position } },
    });
    return true;
  }

  // ---- time -----------------------------------------------------------------

  tick(dtMs: number): MatchEvent[] {
    const events = this.pending;
    this.pending = [];

    if (this.phase !== 'finished' && this.checkWalkover(events)) {
      return events;
    }

    switch (this.phase) {
      case 'starting':
        this.timeLeftMs = (this.timeLeftMs ?? 0) - dtMs;
        if (this.timeLeftMs <= 0) {
          this.startRound(events);
        }
        break;
      case 'round':
        this.timeLeftMs = (this.timeLeftMs ?? 0) - dtMs;
        this.evaluateRound(events);
        break;
      case 'intermission':
        this.timeLeftMs = (this.timeLeftMs ?? 0) - dtMs;
        if (this.timeLeftMs <= 0) {
          if (this.afterBreak === 'sudden_death') {
            this.startSuddenDeath(events);
          } else {
            this.startRound(events);
          }
        }
        break;
      case 'sudden_death':
        this.evaluateSuddenDeath(events);
        break;
      case 'finished':
        if (!this.closed) {
          this.timeLeftMs = (this.timeLeftMs ?? 0) - dtMs;
          if (this.timeLeftMs <= 0) {
            this.closed = true;
            events.push({ type: 'closed' });
          }
        }
        break;
    }
    return events;
  }

  // ---- transitions ----------------------------------------------------------

  private startRound(events: MatchEvent[]): void {
    this.resetRound();
    this.phase = 'round';
    this.timeLeftMs = ROUND_MS;
    events.push({
      type: 'round_started',
      round: this.roundsPlayed + 1,
      suddenDeath: false,
    });
  }

  private startSuddenDeath(events: MatchEvent[]): void {
    this.resetRound();
    this.phase = 'sudden_death';
    this.timeLeftMs = null; // no clock (AC-044)
    events.push({ type: 'round_started', round: null, suddenDeath: true });
  }

  // Everyone back on their feet at their team's spawn, every machine intact
  // (AC-036). Newcomers who were watching join in.
  private resetRound(): void {
    for (const team of ['workers', 'capatazes'] as Team[]) {
      this.teamOf(team).forEach((player, i) => {
        player.status = 'active';
        player.life = MAX_LIFE;
        player.position = this.spawn(team, i);
      });
    }
    this.machines.clear();
    this.map.machineIds.forEach((id) => this.machines.set(id, false));
  }

  private evaluateRound(events: MatchEvent[]): void {
    const machinesBroken = [...this.machines.values()].filter(Boolean).length;
    const workersActive = this.count('workers', 'active');
    const workersDown = this.count('workers', 'incapacitated');

    const winner = roundWinner({
      machinesTotal: this.machines.size,
      machinesBroken,
      timeLeftMs: this.timeLeftMs ?? 0,
      workersActive,
      workersDown,
    });
    if (!winner) {
      return;
    }

    const reason =
      machinesBroken >= this.machines.size
        ? 'machines'
        : workersActive === 0 && workersDown > 0
          ? 'workers_down'
          : 'clock';

    this.score[winner]++;
    this.roundsPlayed++;
    events.push({
      type: 'round_ended',
      winner,
      reason,
      score: { ...this.score },
      roundsPlayed: this.roundsPlayed,
    });

    const outcome = matchOutcome(
      this.score,
      this.roundsPlayed,
      this.roundLimit,
    );
    if (outcome.kind === 'winner') {
      this.finish(outcome.team, 'score', events);
      return;
    }
    if (outcome.kind === 'sudden_death') {
      events.push({ type: 'sudden_death' });
    }
    this.phase = 'intermission';
    this.timeLeftMs = INTERMISSION_MS;
    this.afterBreak =
      outcome.kind === 'sudden_death' ? 'sudden_death' : 'round';
  }

  private evaluateSuddenDeath(events: MatchEvent[]): void {
    const outcome = suddenDeathOutcome({
      workers: this.count('workers', 'active'),
      capatazes: this.count('capatazes', 'active'),
    });
    if (outcome === 'tie') {
      events.push({ type: 'sudden_death_tie' });
      this.startSuddenDeath(events);
    } else if (outcome) {
      this.finish(outcome, 'sudden_death', events);
    }
  }

  private checkWalkover(events: MatchEvent[]): boolean {
    const members = {
      workers: this.teamOf('workers').length,
      capatazes: this.teamOf('capatazes').length,
    };
    const winner = walkoverWinner(members);
    if (winner) {
      this.finish(winner, 'walkover', events);
      return true;
    }
    if (members.workers === 0 && members.capatazes === 0) {
      // nobody left to win: just close
      this.phase = 'finished';
      this.closed = true;
      events.push({ type: 'closed' });
      return true;
    }
    return false;
  }

  private finish(
    winner: Team,
    reason: 'score' | 'sudden_death' | 'walkover',
    events: MatchEvent[],
  ): void {
    this.phase = 'finished';
    this.timeLeftMs = RESULT_MS;
    this.result = { winner, reason };
    events.push({
      type: 'match_ended',
      winner,
      reason,
      score: { ...this.score },
    });
  }

  // ---- helpers --------------------------------------------------------------

  private teamOf(team: Team): MatchPlayer[] {
    return this.players.filter((p) => p.team === team);
  }

  private count(team: Team, status: MatchPlayer['status']): number {
    return this.teamOf(team).filter((p) => p.status === status).length;
  }

  private spawn(team: Team, index: number): Point {
    const spawns = this.map.spawns[team];
    return { ...spawns[index % spawns.length] };
  }
}
