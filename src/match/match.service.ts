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

// What listeners hear: everything a Match reports, plus the moment it starts.
export type MatchServiceEvent =
  | MatchEvent
  | { type: 'started'; view: MatchView };

const TICK_MS = 1000 / 60; // fixed step: the game runs at 60 Hz
const MAX_STEP_MS = 250; // a stalled process must not skip whole rounds

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

  private readonly matches = new Map<string, Match>();
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

  // The match a player is currently in, for syncing after a reconnect.
  viewFor(sessionId: string): MatchView | null {
    const code = this.rooms.roomOf(sessionId)?.code;
    return (code && this.matches.get(code)?.view()) || null;
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
    for (const [code, match] of this.matches) {
      for (const event of match.tick(dtMs)) {
        this.emit(code, event);
        if (event.type === 'closed') {
          this.matches.delete(code);
          this.rooms.returnToLobby(code);
        }
      }
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
