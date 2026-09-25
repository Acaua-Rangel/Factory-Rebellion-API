import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RoomEvent } from '../rooms/room.types';
import { RoomsService } from '../rooms/rooms.service';
import {
  DEFAULT_MAP,
  Match,
  MatchEvent,
  MatchMap,
  MatchView,
} from './match-state';
import { GameMap, loadMap } from './map';
import { Physics } from './physics';
import { Simulation } from './simulation';
import { Snapshot, buildSnapshot } from './snapshot';

// What listeners hear: everything a Match reports, plus the moment it starts.
export type MatchServiceEvent =
  | MatchEvent
  | { type: 'started'; view: MatchView }
  // the world 20 times a second, plus each player's last applied input number
  | { type: 'snapshot'; snapshot: Snapshot; acks: Record<string, number> };

const TICK_MS = 1000 / 60; // fixed step: the game runs at 60 Hz
const MAX_STEP_MS = 250; // a stalled process must not skip whole rounds
const FRAME_MS = 1000 / 60; // one physics frame
const MAX_FRAMES_PER_TICK = 15; // = MAX_STEP_MS: catching up is bounded
const FRAMES_PER_SNAPSHOT = 3; // 60 Hz / 3 = 20 snapshots a second

// Runs the matches of every room that started one: creates the Match when the
// host starts, keeps its clock ticking, follows players in and out of the room
// and puts the room back in the lobby when the match closes (AC-045).
@Injectable()
export class MatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchService.name);

  // Map layout; replaced by the one exported from the game room (T-026).
  map: MatchMap = DEFAULT_MAP;
  // Random source for the team draw; tests replace it.
  draw?: (max: number) => number;
  // Injectable clock so tests don't have to wait real seconds.
  clock: () => number = () => Date.now();

  // Collision map the physics runs on (the exported room).
  gameMap: GameMap = loadMap();

  private physics = new Physics(this.gameMap);
  private readonly matches = new Map<string, Match>();
  private readonly simulations = new Map<string, Simulation>();
  private frameDebt = 0;
  private readonly listeners: ((
    code: string,
    event: MatchServiceEvent,
  ) => void)[] = [];
  private timer?: NodeJS.Timeout;
  private lastStep = 0;

  constructor(private readonly rooms: RoomsService) {
    rooms.onEvent((event) => this.onRoomEvent(event));
  }

  onModuleInit(): void {
    this.lastStep = this.clock();
    this.timer = setInterval(() => {
      const now = this.clock();
      const elapsed = Math.min(now - this.lastStep, MAX_STEP_MS);
      this.lastStep = now;
      this.tick(elapsed);
    }, TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  onEvent(listener: (code: string, event: MatchServiceEvent) => void): void {
    this.listeners.push(listener);
  }

  getMatch(code: string): Match | undefined {
    return this.matches.get(code);
  }

  getSimulation(code: string): Simulation | undefined {
    return this.simulations.get(code);
  }

  // The match a player is currently in, for syncing after a reconnect.
  viewFor(sessionId: string): MatchView | null {
    const code = this.rooms.roomOf(sessionId)?.code;
    return (code && this.matches.get(code)?.view()) || null;
  }

  // ---- what clients send ---------------------------------------------------

  // Key states with numbers from a client; only the four keys are read (AC-062).
  enqueueInput(sessionId: string, raw: unknown): void {
    const code = this.rooms.roomOf(sessionId)?.code;
    if (code) {
      this.simulations.get(code)?.enqueue(sessionId, raw);
    }
  }

  // A reloaded client starts counting its inputs from 1 again.
  resyncInputs(sessionId: string): void {
    const code = this.rooms.roomOf(sessionId)?.code;
    if (code) {
      this.simulations.get(code)?.resync(sessionId);
    }
  }

  // ---- what other features report -----------------------------------------

  machineBroken(code: string, machineId: string): void {
    this.matches.get(code)?.machineBroken(machineId);
  }

  playerDown(code: string, sessionId: string): void {
    this.matches.get(code)?.playerDown(sessionId);
  }

  // ---- time ---------------------------------------------------------------

  tick(dtMs: number): void {
    // 1) the rules: rounds, clock, who won
    for (const [code, match] of this.matches) {
      for (const event of match.tick(dtMs)) {
        this.follow(code, match, event);
        this.emit(code, event);
        if (event.type === 'closed') {
          this.matches.delete(code);
          this.simulations.delete(code);
          this.rooms.returnToLobby(code);
        }
      }
    }

    // 2) the physics, in fixed frames of 1/60 s
    this.frameDebt += dtMs;
    const frames = Math.min(
      Math.floor(this.frameDebt / FRAME_MS),
      MAX_FRAMES_PER_TICK,
    );
    // whatever a stall left over is forgotten, not paid back later
    this.frameDebt = Math.min(this.frameDebt - frames * FRAME_MS, FRAME_MS);
    for (let frame = 0; frame < frames; frame++) {
      for (const [code, match] of this.matches) {
        this.stepPhysics(code, match, frame === frames - 1);
      }
    }
  }

  // ---- the physical world ---------------------------------------------------

  // Keeps the simulation in step with what the rules just announced.
  private follow(code: string, match: Match, event: MatchEvent): void {
    const sim = this.simulations.get(code);
    if (!sim) {
      return;
    }
    if (event.type === 'round_started') {
      // every body back at its spawn (the match already moved the players)
      for (const player of match.view().players) {
        sim.add(player.sessionId, player.position);
      }
    } else if (event.type === 'player_left') {
      sim.remove(event.sessionId);
    } else if (event.type === 'player_joined') {
      sim.add(event.player.sessionId, event.player.position);
    }
  }

  private stepPhysics(code: string, match: Match, lastOfTick: boolean): void {
    const sim = this.simulations.get(code);
    if (!sim) {
      return;
    }
    for (const id of match.playerIds()) {
      sim.step(id, match.canMove(id));
      const body = sim.bodyOf(id);
      if (body) {
        match.setPosition(id, body.x, body.y);
      }
    }
    sim.advance();

    // 20 snapshots a second while a round is on, at most one per tick
    if (lastOfTick && match.playing && sim.frame % FRAMES_PER_SNAPSHOT === 0) {
      const acks: Record<string, number> = {};
      for (const id of match.playerIds()) {
        acks[id] = sim.ackOf(id);
      }
      this.emit(code, {
        type: 'snapshot',
        snapshot: buildSnapshot(match.view(), sim),
        acks,
      });
    }
  }

  // ---- the room ------------------------------------------------------------

  private onRoomEvent(event: RoomEvent): void {
    switch (event.type) {
      case 'started': {
        const { code, members, settings } = event.room;
        const match = new Match({
          roomCode: code,
          players: members.map(({ sessionId, nickname }) => ({
            sessionId,
            nickname,
          })),
          rounds: settings.rounds,
          map: this.map,
          draw: this.draw,
        });
        this.matches.set(code, match);
        const sim = new Simulation(this.physics);
        for (const player of match.view().players) {
          sim.add(player.sessionId, player.position);
        }
        this.simulations.set(code, sim);
        this.emit(code, { type: 'started', view: match.view() });
        break;
      }
      case 'member_removed':
        this.matches.get(event.code)?.removePlayer(event.sessionId);
        break;
      case 'member_added': {
        const match = this.matches.get(event.code);
        const member = this.rooms
          .getRoom(event.code)
          ?.members.find((m) => m.sessionId === event.sessionId);
        if (
          match &&
          member &&
          !match.addPlayer(member.sessionId, member.nickname)
        ) {
          this.logger.warn(
            `no open seat for ${member.nickname} in ${event.code}`,
          );
        }
        break;
      }
      case 'deleted':
        this.matches.delete(event.code);
        this.simulations.delete(event.code);
        break;
    }
  }

  private emit(code: string, event: MatchServiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(code, event);
      } catch (error) {
        this.logger.error(`match listener failed: ${(error as Error).message}`);
      }
    }
  }
}
