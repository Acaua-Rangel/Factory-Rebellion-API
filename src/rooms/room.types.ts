export interface RoomSettings {
  size: 4 | 8;
  visibility: 'public' | 'private';
  // rounds played before sudden death
  rounds: 4 | 5 | 6;
}

export interface RoomMember {
  sessionId: string;
  nickname: string;
  // false while the player's connection is down (the seat is kept for 60 s)
  connected: boolean;
}

export type RoomPhase = 'lobby' | 'match';

export interface Room {
  code: string;
  settings: RoomSettings;
  hostId: string;
  phase: RoomPhase;
  // in the order they joined: the first one is the longest-standing member
  members: RoomMember[];
  // session ids kicked from this room (AC-074)
  banned: Set<string>;
}

// What players are allowed to see of a room: never the token (P-005) nor the ban list.
export interface RoomView {
  code: string;
  settings: RoomSettings;
  hostId: string;
  phase: RoomPhase;
  members: RoomMember[];
}

// One row of the public room browser (AC-019).
export interface PublicRoomListing {
  code: string;
  host: string;
  players: number;
  size: number;
  rounds: number;
  inMatch: boolean;
}

export type RoomEvent =
  | { type: 'updated'; room: RoomView }
  | { type: 'deleted'; code: string }
  | { type: 'started'; room: RoomView }
  | { type: 'kicked'; code: string; sessionId: string }
  // the match listens to these two to fill or free seats
  | { type: 'member_added'; code: string; sessionId: string }
  | { type: 'member_removed'; code: string; sessionId: string };

export const ROOM_ERROR_MESSAGES = {
  invalid_settings: 'invalid settings',
  room_not_found: 'room not found',
  room_full: 'room full',
  match_in_progress: 'match in progress',
  too_many_attempts: 'too many attempts, wait a minute',
  room_not_full: 'room not full',
  only_host_can_start: 'only the host can start',
  only_host_can_change_settings: 'only the host can change settings',
  only_host_can_kick: 'only the host can kick',
  too_many_players_for_size: 'too many players for this size',
  banned: 'you were banned from this room',
  not_in_room: 'you are not in a room',
  not_in_lobby: 'the match already started',
  member_not_found: 'that player is not in the room',
  cannot_kick_yourself: 'you cannot kick yourself',
} as const;

export type RoomErrorCode = keyof typeof ROOM_ERROR_MESSAGES;

export class RoomError extends Error {
  constructor(readonly code: RoomErrorCode) {
    super(ROOM_ERROR_MESSAGES[code]);
  }
}
