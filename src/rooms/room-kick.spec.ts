import { PublicSession } from '../session/session.service';
import { JoinLimiter } from './join-limiter';
import { RoomError, RoomErrorCode, RoomEvent } from './room.types';
import { RoomsService } from './rooms.service';

const player = (id: string): PublicSession => ({
  sessionId: id,
  nickname: id.toUpperCase(),
});
const settings = { size: 4, visibility: 'public' };

const expectRoomError = (
  fn: () => unknown,
  code: RoomErrorCode,
  message: string,
) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RoomError);
    expect((error as RoomError).code).toBe(code);
    expect((error as RoomError).message).toBe(message);
    return;
  }
  throw new Error(`expected RoomError ${code}, nothing was thrown`);
};

describe('Kicking and banning', () => {
  let rooms: RoomsService;
  let events: RoomEvent[];
  let code: string;

  beforeEach(() => {
    rooms = new RoomsService(new JoinLimiter());
    events = [];
    code = rooms.createRoom(player('ana'), settings).code;
    rooms.join(player('bia'), code);
    rooms.join(player('cris'), code);
    rooms.onEvent((event) => events.push(event));
  });

  it('AC-073: the host removes a member and everyone else sees the new list @spec:AC-073', () => {
    rooms.kick('ana', 'bia');

    expect(rooms.getRoom(code)?.members.map((m) => m.sessionId)).toEqual([
      'ana',
      'cris',
    ]);
    expect(rooms.roomOf('bia')).toBeUndefined();
    expect(events).toContainEqual({ type: 'kicked', code, sessionId: 'bia' });
    expect(events).toContainEqual({
      type: 'updated',
      room: expect.objectContaining({
        members: [
          expect.objectContaining({ sessionId: 'ana' }),
          expect.objectContaining({ sessionId: 'cris' }),
        ],
      }),
    });
  });

  it('AC-073: a member who is not the host cannot kick @spec:AC-073', () => {
    expectRoomError(
      () => rooms.kick('bia', 'cris'),
      'only_host_can_kick',
      'only the host can kick',
    );
    expect(rooms.getRoom(code)?.members).toHaveLength(3);
    expect(events).toEqual([]);
  });

  it('AC-073: kicking is only possible in the lobby, not during a match @spec:AC-073', () => {
    rooms.join(player('dani'), code);
    rooms.start('ana');

    expectRoomError(
      () => rooms.kick('ana', 'bia'),
      'not_in_lobby',
      'the match already started',
    );
    expect(rooms.getRoom(code)?.members).toHaveLength(4);
  });

  it('AC-073: the host cannot kick themselves and cannot kick strangers @spec:AC-073', () => {
    expectRoomError(
      () => rooms.kick('ana', 'ana'),
      'cannot_kick_yourself',
      'you cannot kick yourself',
    );
    expectRoomError(
      () => rooms.kick('ana', 'nobody'),
      'member_not_found',
      'that player is not in the room',
    );
    expect(rooms.getRoom(code)?.members).toHaveLength(3);
  });

  it('AC-073: a player outside any room cannot kick @spec:AC-073', () => {
    expectRoomError(
      () => rooms.kick('nobody', 'ana'),
      'not_in_room',
      'you are not in a room',
    );
  });

  it('AC-074: a kicked player cannot come back to that room @spec:AC-074', () => {
    rooms.kick('ana', 'bia');

    expectRoomError(
      () => rooms.join(player('bia'), code),
      'banned',
      'you were banned from this room',
    );
    expect(rooms.getRoom(code)?.members).toHaveLength(2);
  });

  it('AC-074: the ban only covers that room; the kicked player can join others @spec:AC-074', () => {
    const other = rooms.createRoom(player('dani'), settings);
    rooms.kick('ana', 'bia');

    expect(rooms.join(player('bia'), other.code).members).toHaveLength(2);
  });

  it('AC-074: the ban is not shown to players (not part of the room view) @spec:AC-074', () => {
    rooms.kick('ana', 'bia');

    const view = rooms.viewOf(rooms.getRoom(code)!);

    expect(JSON.stringify(view)).not.toContain('banned');
  });

  it('AC-074: the ban ends together with the room @spec:AC-074', () => {
    rooms.kick('ana', 'bia');
    rooms.leave('ana');
    rooms.leave('cris');
    expect(rooms.getRoom(code)).toBeUndefined();

    // a brand new room may even get the same code; the old ban is gone
    rooms.draw = () => 0;
    const fresh = rooms.createRoom(player('eva'), settings);

    expect(rooms.join(player('bia'), fresh.code).members).toHaveLength(2);
  });

  it('AC-073: the host role passes on normally after a kick of the second member @spec:AC-073', () => {
    rooms.kick('ana', 'bia');
    rooms.leave('ana');

    expect(rooms.getRoom(code)?.hostId).toBe('cris');
  });
});
