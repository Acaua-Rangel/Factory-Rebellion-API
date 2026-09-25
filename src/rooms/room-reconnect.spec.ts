import { PublicSession } from '../session/session.service';
import { JoinLimiter } from './join-limiter';
import { RoomEvent } from './room.types';
import { RoomsService } from './rooms.service';

const player = (id: string): PublicSession => ({
  sessionId: id,
  nickname: id.toUpperCase(),
});

describe('Keeping the seat after a connection drop', () => {
  let rooms: RoomsService;
  let events: RoomEvent[];
  let code: string;

  beforeEach(() => {
    rooms = new RoomsService(new JoinLimiter());
    code = rooms.createRoom(player('ana'), {
      size: 4,
      visibility: 'public',
    }).code;
    rooms.join(player('bia'), code);
    rooms.join(player('cris'), code);
    events = [];
    rooms.onEvent((event) => events.push(event));
  });

  const seats = () =>
    rooms.getRoom(code)?.members.map((m) => `${m.sessionId}:${m.connected}`);

  it('AC-032: a dropped player keeps their seat, marked as disconnected @spec:AC-032', () => {
    rooms.setConnected('bia', false);

    expect(seats()).toEqual(['ana:true', 'bia:false', 'cris:true']);
    expect(rooms.roomOf('bia')?.code).toBe(code);
    expect(events).toEqual([
      { type: 'updated', room: expect.objectContaining({ code }) },
    ]);
  });

  it('AC-032: coming back restores the same seat @spec:AC-032', () => {
    rooms.setConnected('bia', false);
    rooms.setConnected('bia', true);

    expect(seats()).toEqual(['ana:true', 'bia:true', 'cris:true']);
  });

  it('AC-032: a dropped player still counts as a member, so the room stays full @spec:AC-032', () => {
    rooms.join(player('dani'), code);
    rooms.setConnected('dani', false);

    expect(() => rooms.join(player('late'), code)).toThrow('room full');
  });

  it('AC-032: after the grace period the seat is freed @spec:AC-032', () => {
    rooms.setConnected('bia', false);

    rooms.removeSession('bia');

    expect(seats()).toEqual(['ana:true', 'cris:true']);
    expect(rooms.roomOf('bia')).toBeUndefined();
  });

  it('AC-030: the host role passes on when the host is gone for good @spec:AC-030', () => {
    rooms.setConnected('ana', false);
    expect(rooms.getRoom(code)?.hostId).toBe('ana'); // still the host while the seat is kept

    rooms.removeSession('ana');

    expect(rooms.getRoom(code)?.hostId).toBe('bia');
  });

  it('AC-031: the room disappears when its last members expire @spec:AC-031', () => {
    for (const id of ['ana', 'bia', 'cris']) {
      rooms.setConnected(id, false);
    }
    for (const id of ['ana', 'bia', 'cris']) {
      rooms.removeSession(id);
    }

    expect(rooms.count()).toBe(0);
    expect(events.at(-1)).toEqual({ type: 'deleted', code });
  });

  it('players outside any room are ignored, no events, no errors', () => {
    events.length = 0;

    rooms.setConnected('nobody', false);
    rooms.removeSession('nobody');

    expect(events).toEqual([]);
  });

  it('nothing is emitted when the connection state does not change', () => {
    events.length = 0;

    rooms.setConnected('bia', true);

    expect(events).toEqual([]);
  });
});
