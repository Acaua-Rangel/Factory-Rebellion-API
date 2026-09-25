import { Injectable, OnModuleInit } from '@nestjs/common';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { RoomsService } from '../rooms/rooms.service';
import { INTERMISSION_MS } from './match-state';
import { MatchService, MatchServiceEvent } from './match.service';

// Match messages, server → client (to every member of the room):
//   match.started {view} · match.round_started {round, suddenDeath, view} ·
//   match.round_ended {winner, reason, score, roundsPlayed, nextInMs} ·
//   match.sudden_death · match.tie · match.ended {winner, reason, score} ·
//   match.player_joined {player} · match.player_left {sessionId}
//   match.snapshot {tick, phase, round, suddenDeath, timeLeftMs, score, players,
//     bullets, machines, ack} — 20 times a second while a round is on; `ack` is
//     the number of the last input the server applied for THIS player.
// Client → server:
//   input {inputs: [{seq, l, r, j, f}, …]} — key states (1/0) with an increasing
//     number, one per 1/60 s frame; nothing else in it is ever read.
//   match.sync, answered with match.state {view | null} — used after loading
//     the game screen or reconnecting; it also restarts the input numbering. Views only hold public data:
// nicknames, teams, roles, positions… never a session token (P-005).
@Injectable()
export class MatchGateway implements OnModuleInit {
  constructor(
    private readonly realtime: RealtimeGateway,
    private readonly matches: MatchService,
    private readonly rooms: RoomsService,
  ) {}

  onModuleInit(): void {
    this.realtime.registerHandler('input', ({ session }, data) => {
      this.matches.enqueueInput(session.sessionId, data);
    });
    this.realtime.registerHandler('match.sync', ({ session }) => {
      this.matches.resyncInputs(session.sessionId);
      this.realtime.sendTo(session.sessionId, 'match.state', {
        view: this.matches.viewFor(session.sessionId),
      });
    });
    this.matches.onEvent((code, event) => this.deliver(code, event));
  }

  private deliver(code: string, event: MatchServiceEvent): void {
    switch (event.type) {
      case 'snapshot':
        // the same world for everyone, plus each player's own acknowledged input
        for (const member of this.rooms.getRoom(code)?.members ?? []) {
          this.realtime.sendTo(member.sessionId, 'match.snapshot', {
            ...event.snapshot,
            ack: event.acks[member.sessionId] ?? 0,
          });
        }
        return;
      case 'started':
        return this.broadcast(code, 'match.started', { view: event.view });
      case 'round_started':
        return this.broadcast(code, 'match.round_started', {
          round: event.round,
          suddenDeath: event.suddenDeath,
          view: this.matches.getMatch(code)?.view(),
        });
      case 'round_ended':
        return this.broadcast(code, 'match.round_ended', {
          winner: event.winner,
          reason: event.reason,
          score: event.score,
          roundsPlayed: event.roundsPlayed,
          nextInMs: INTERMISSION_MS,
        });
      case 'sudden_death':
        return this.broadcast(code, 'match.sudden_death', {});
      case 'sudden_death_tie':
        return this.broadcast(code, 'match.tie', {});
      case 'match_ended':
        return this.broadcast(code, 'match.ended', {
          winner: event.winner,
          reason: event.reason,
          score: event.score,
        });
      case 'player_joined':
        return this.broadcast(code, 'match.player_joined', {
          player: event.player,
        });
      case 'player_left':
        return this.broadcast(code, 'match.player_left', {
          sessionId: event.sessionId,
        });
      case 'closed':
        // the rooms gateway already sends room.state with phase "lobby"
        return;
    }
  }

  private broadcast(code: string, type: string, data: unknown): void {
    for (const member of this.rooms.getRoom(code)?.members ?? []) {
      this.realtime.sendTo(member.sessionId, type, data);
    }
  }
}
