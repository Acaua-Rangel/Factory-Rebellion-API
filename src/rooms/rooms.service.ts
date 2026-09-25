import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PublicSession } from '../session/session.service';
import {
  CreateRoomSchema,
  UpdateRoomSettingsSchema,
} from './dtos/room-settings.dto';
import { JoinLimiter } from './join-limiter';
import { generateRoomCode, normalizeRoomCode } from './room-code';
import {
  PublicRoomListing,
  Room,
  RoomError,
  RoomEvent,
  RoomView,
} from './room.types';

// All the room rules, with no sockets in sight: the gateway turns the events
// this service emits into messages. Everything lives in memory (ASM-002).
@Injectable()
export class RoomsService {
  // Random source for room codes; tests replace it to get predictable codes.
  draw: (max: number) => number = (max) => randomInt(max);

  private readonly rooms = new Map<string, Room>();
  private readonly roomByMember = new Map<string, string>();
  private readonly listeners: ((event: RoomEvent) => void)[] = [];

  constructor(private readonly limiter: JoinLimiter) {}

  onEvent(listener: (event: RoomEvent) => void): void {
    this.listeners.push(listener);
  }

  count(): number {
    return this.rooms.size;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  roomOf(sessionId: string): Room | undefined {
    const code = this.roomByMember.get(sessionId);
    return code ? this.rooms.get(code) : undefined;
  }

  viewOf(room: Room): RoomView {
    return {
      code: room.code,
      settings: { ...room.settings },
      hostId: room.hostId,
      phase: room.phase,
      members: room.members.map((member) => ({ ...member })),
    };
  }

  // Public rooms that still have a free seat: waiting in the lobby, or in a
  // match that lost a player (AC-019, AC-020).
  listPublic(): PublicRoomListing[] {
    const listing: PublicRoomListing[] = [];
    for (const room of this.rooms.values()) {
      const { size, visibility, rounds } = room.settings;
      if (visibility !== 'public' || room.members.length >= size) {
        continue;
      }
      listing.push({
        code: room.code,
        host: this.member(room, room.hostId)?.nickname ?? '',
        players: room.members.length,
        size,
        rounds,
        inMatch: room.phase === 'match',
      });
    }
    return listing;
  }

  createRoom(session: PublicSession, input: unknown): Room {
    const parsed = CreateRoomSchema.safeParse(input);
    if (!parsed.success) {
      throw new RoomError('invalid_settings');
    }

    this.removeMember(session.sessionId);

    const room: Room = {
      code: generateRoomCode((code) => this.rooms.has(code), this.draw),
      settings: parsed.data,
      hostId: session.sessionId,
      phase: 'lobby',
      members: [],
      banned: new Set(),
    };
    this.rooms.set(room.code, room);
    this.addMember(room, session);
    return room;
  }

  join(session: PublicSession, typedCode: unknown): Room {
    const { sessionId } = session;
    if (this.limiter.isBlocked(sessionId)) {
      throw new RoomError('too_many_attempts');
    }

    const code = normalizeRoomCode(typedCode);
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) {
      this.limiter.recordFailure(sessionId);
      throw new RoomError('room_not_found');
    }
    if (room.banned.has(sessionId)) {
      throw new RoomError('banned');
    }
    if (this.roomByMember.get(sessionId) === room.code) {
      return room;
    }
    if (room.members.length >= room.settings.size) {
      throw new RoomError(
        room.phase === 'match' ? 'match_in_progress' : 'room_full',
      );
    }

    this.removeMember(sessionId);
    this.addMember(room, session);
    return room;
  }

  leave(sessionId: string): void {
    if (!this.roomByMember.has(sessionId)) {
      throw new RoomError('not_in_room');
    }
    this.removeMember(sessionId);
  }

  updateSettings(sessionId: string, input: unknown): Room {
    const room = this.hostRoom(sessionId, 'only_host_can_change_settings');
    if (room.phase !== 'lobby') {
      throw new RoomError('not_in_lobby');
    }

    const parsed = UpdateRoomSettingsSchema.safeParse(input);
    if (!parsed.success) {
      throw new RoomError('invalid_settings');
    }
    const settings = { ...room.settings };
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) {
        (settings as Record<string, unknown>)[key] = value;
      }
    }
    if (settings.size < room.members.length) {
      throw new RoomError('too_many_players_for_size');
    }

    room.settings = settings;
    this.emit({ type: 'updated', room: this.viewOf(room) });
    return room;
  }

  start(sessionId: string): Room {
    const room = this.hostRoom(sessionId, 'only_host_can_start');
    if (room.phase !== 'lobby') {
      throw new RoomError('not_in_lobby');
    }
    if (room.members.length < room.settings.size) {
      throw new RoomError('room_not_full');
    }

    room.phase = 'match';
    const view = this.viewOf(room);
    this.emit({ type: 'started', room: view });
    this.emit({ type: 'updated', room: view });
    return room;
  }

  // The match is over: same members, same host, ready to start again
  // (AC-045, ASM-010).
  returnToLobby(code: string): void {
    const room = this.rooms.get(code);
    if (!room || room.phase !== 'match') {
      return;
    }
    room.phase = 'lobby';
    this.emit({ type: 'updated', room: this.viewOf(room) });
  }

  // The host removes a member from the lobby and bans them from this room
  // (AC-073, AC-074). The ban lasts as long as the room exists (ASM-028).
  kick(hostSessionId: string, targetSessionId: string): void {
    const room = this.hostRoom(hostSessionId, 'only_host_can_kick');
    if (room.phase !== 'lobby') {
      throw new RoomError('not_in_lobby');
    }
    if (targetSessionId === hostSessionId) {
      throw new RoomError('cannot_kick_yourself');
    }
    if (!this.member(room, targetSessionId)) {
      throw new RoomError('member_not_found');
    }

    room.banned.add(targetSessionId);
    this.removeMember(targetSessionId);
    this.emit({
      type: 'kicked',
      code: room.code,
      sessionId: targetSessionId,
    });
  }

  // A connection dropped or came back: the seat is kept either way (AC-032).
  setConnected(sessionId: string, connected: boolean): void {
    const room = this.roomOf(sessionId);
    const member = room && this.member(room, sessionId);
    if (!room || !member || member.connected === connected) {
      return;
    }
    member.connected = connected;
    this.emit({ type: 'updated', room: this.viewOf(room) });
  }

  // The 60 s reconnect window ended: free the seat, whatever the room's phase.
  removeSession(sessionId: string): void {
    this.removeMember(sessionId);
  }

  // The room of a player who must be its host (or the error to raise).
  private hostRoom(
    sessionId: string,
    notHost:
      | 'only_host_can_start'
      | 'only_host_can_change_settings'
      | 'only_host_can_kick',
  ): Room {
    const room = this.roomOf(sessionId);
    if (!room) {
      throw new RoomError('not_in_room');
    }
    if (room.hostId !== sessionId) {
      throw new RoomError(notHost);
    }
    return room;
  }

  private addMember(room: Room, session: PublicSession): void {
    room.members.push({
      sessionId: session.sessionId,
      nickname: session.nickname,
      connected: true,
    });
    this.roomByMember.set(session.sessionId, room.code);
    this.emit({
      type: 'member_added',
      code: room.code,
      sessionId: session.sessionId,
    });
    this.emit({ type: 'updated', room: this.viewOf(room) });
  }

  // Takes a player out of their room (if any): passes the host role on and
  // deletes the room when it empties (AC-029, AC-030, AC-031).
  private removeMember(sessionId: string): void {
    const room = this.roomOf(sessionId);
    if (!room) {
      return;
    }
    room.members = room.members.filter((m) => m.sessionId !== sessionId);
    this.roomByMember.delete(sessionId);
    this.emit({ type: 'member_removed', code: room.code, sessionId });

    if (room.members.length === 0) {
      this.rooms.delete(room.code);
      this.emit({ type: 'deleted', code: room.code });
      return;
    }
    if (room.hostId === sessionId) {
      room.hostId = room.members[0].sessionId;
    }
    this.emit({ type: 'updated', room: this.viewOf(room) });
  }

  private member(room: Room, sessionId: string) {
    return room.members.find((m) => m.sessionId === sessionId);
  }

  private emit(event: RoomEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
