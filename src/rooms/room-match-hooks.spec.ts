import { PublicSession } from '../session/session.service';
import { JoinLimiter } from './join-limiter';
import { RoomEvent } from './room.types';
import { RoomsService } from './rooms.service';

const player = (id: string): PublicSession => ({
  sessionId: id,
  nickname: id.toUpperCase(),
});

describe('Room events the match listens to', () => {
  let rooms: RoomsService;
  let events: RoomEvent[];

  beforeEach(() => {
    rooms = new RoomsService(new JoinLimiter());
    events = [];
    rooms.onEvent((event) => events.push(event));
  });

  const startedRoom = () => {
    const room = rooms.createRoom(player('p1'), {
      size: 4,
      visibility: 'public',
    });
    for (const id of ['p2', 'p3', 'p4']) rooms.join(player(id), room.code);
    rooms.start('p1');
    events.length = 0;
    return room;
  };

  const only = (type: RoomEvent['type']) =>
    events.filter((e) => e.type === type);

  it('AC-072: someone joining announces which room and which player @spec:AC-072', () => {
    const room = startedRoom();
    rooms.leave('p4');
    events.length = 0;

    rooms.join(player('late'), room.code);

    expect(only('member_added')).toEqual([
      { type: 'member_added', code: room.code, sessionId: 'late' },
    ]);
  });

  it('AC-046: someone leaving announces it, whatever the way out @spec:AC-046', () => {
    const room = startedRoom();

    rooms.leave('p2');
    rooms.removeSession('p3');

    expect(only('member_removed')).toEqual([
      { type: 'member_removed', code: room.code, sessionId: 'p2' },
      { type: 'member_removed', code: room.code, sessionId: 'p3' },
    ]);
  });

  it('a player who moves to another room leaves the first one (announced) and enters the second', () => {
    const first = startedRoom();
    const second = rooms.createRoom(player('other'), {
      size: 4,
      visibility: 'public',
    });
    events.length = 0;

    rooms.join(player('p2'), second.code);

    expect(only('member_removed')).toEqual([
      { type: 'member_removed', code: first.code, sessionId: 'p2' },
    ]);
    expect(only('member_added')).toEqual([
      { type: 'member_added', code: second.code, sessionId: 'p2' },
    ]);
  });

  it('the last member leaving announces the removal and then the deletion', () => {
    const room = rooms.createRoom(player('ana'), {
      size: 4,
      visibility: 'public',
    });
    events.length = 0;

    rooms.leave('ana');

    expect(events.map((e) => e.type)).toEqual(['member_removed', 'deleted']);
    expect(events[0]).toEqual({
      type: 'member_removed',
      code: room.code,
      sessionId: 'ana',
    });
  });

  it('AC-045: after the match the room goes back to the lobby with the same members and host @spec:AC-045', () => {
    const room = startedRoom();
    const before = rooms.viewOf(rooms.getRoom(room.code)!).members;

    rooms.returnToLobby(room.code);

    const after = rooms.viewOf(rooms.getRoom(room.code)!);
    expect(after.phase).toBe('lobby');
    expect(after.hostId).toBe('p1');
    expect(after.members).toEqual(before);
    expect(only('updated')).toEqual([
      { type: 'updated', room: expect.objectContaining({ phase: 'lobby' }) },
    ]);
  });

  it('AC-045: back in the lobby the host can start again @spec:AC-045', () => {
    const room = startedRoom();
    rooms.returnToLobby(room.code);

    expect(rooms.start('p1').phase).toBe('match');
  });

  it('AC-045: back in the lobby, kicking and settings work again, and the list shows a room with seats @spec:AC-045', () => {
    const room = startedRoom();
    rooms.leave('p4');
    rooms.returnToLobby(room.code);

    expect(rooms.updateSettings('p1', { rounds: 6 }).settings.rounds).toBe(6);
    expect(rooms.listPublic().map((r) => r.inMatch)).toEqual([false]);
    expect(rooms.getRoom(room.code)?.banned.size).toBe(0);
  });

  it('returning a room that is not in a match, or does not exist, does nothing', () => {
    const room = rooms.createRoom(player('ana'), {
      size: 4,
      visibility: 'public',
    });
    events.length = 0;

    rooms.returnToLobby(room.code);
    rooms.returnToLobby('ZZZZ-ZZZZ');

    expect(events).toEqual([]);
  });
});
