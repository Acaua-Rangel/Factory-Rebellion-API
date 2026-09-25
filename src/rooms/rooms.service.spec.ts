import { PublicSession } from '../session/session.service';
import { JoinLimiter } from './join-limiter';
import { RoomError, RoomErrorCode, RoomEvent } from './room.types';
import { RoomsService } from './rooms.service';

const player = (id: string, nickname = id.toUpperCase()): PublicSession => ({
  sessionId: id,
  nickname,
});

const settings = (size: 4 | 8 = 4, visibility = 'public', rounds?: number) => ({
  size,
  visibility,
  ...(rounds === undefined ? {} : { rounds }),
});

// asserts that fn throws a RoomError with the given code and message
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

describe('RoomsService', () => {
  let rooms: RoomsService;
  let limiter: JoinLimiter;
  let events: RoomEvent[];

  beforeEach(() => {
    limiter = new JoinLimiter();
    rooms = new RoomsService(limiter);
    events = [];
    // member_added / member_removed are for the match and have their own spec
    // (room-match-hooks.spec.ts); here we look at what players get to see
    rooms.onEvent((event) => {
      if (event.type !== 'member_added' && event.type !== 'member_removed') {
        events.push(event);
      }
    });
  });

  // fills a room up to its size with fresh players p1..pN (creator first)
  const fullRoom = (size: 4 | 8 = 4, visibility = 'public') => {
    const room = rooms.createRoom(player('p1'), settings(size, visibility));
    for (let i = 2; i <= size; i++) {
      rooms.join(player(`p${i}`), room.code);
    }
    return room;
  };

  describe('creating rooms', () => {
    it('AC-014: creates a room with a code, the chosen settings and the creator as host @spec:AC-014', () => {
      const room = rooms.createRoom(player('ana'), settings(8, 'private', 5));

      expect(room.code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
      expect(room.settings).toEqual({
        size: 8,
        visibility: 'private',
        rounds: 5,
      });
      expect(room.hostId).toBe('ana');
      expect(room.members).toEqual([
        { sessionId: 'ana', nickname: 'ANA', connected: true },
      ]);
      expect(room.phase).toBe('lobby');
      expect(rooms.count()).toBe(1);
    });

    it('AC-014: every size, visibility and rounds option is accepted @spec:AC-014', () => {
      let id = 0;
      for (const size of [4, 8] as const) {
        for (const visibility of ['public', 'private']) {
          for (const rounds of [4, 5, 6]) {
            const room = rooms.createRoom(
              player(`x${id++}`),
              settings(size, visibility, rounds),
            );
            expect(room.settings).toEqual({ size, visibility, rounds });
          }
        }
      }
    });

    it.each([
      ['size 5', { size: 5, visibility: 'public' }],
      ['size 6', { size: 6, visibility: 'public' }],
      ['size "4"', { size: '4', visibility: 'public' }],
      ['rounds 3', { size: 4, visibility: 'public', rounds: 3 }],
      ['rounds 7', { size: 4, visibility: 'public', rounds: 7 }],
      ['unknown visibility', { size: 4, visibility: 'friends' }],
      ['missing size', { visibility: 'public' }],
      ['missing visibility', { size: 4 }],
      ['not an object', 'public'],
      ['nothing', undefined],
    ])(
      'AC-015: invalid settings (%s) are refused @spec:AC-015',
      (_label, input) => {
        expectRoomError(
          () => rooms.createRoom(player('ana'), input),
          'invalid_settings',
          'invalid settings',
        );
        expect(rooms.count()).toBe(0);
        expect(rooms.roomOf('ana')).toBeUndefined();
      },
    );

    it('AC-016: rounds default to 4 @spec:AC-016', () => {
      const room = rooms.createRoom(player('ana'), settings(4, 'public'));

      expect(room.settings.rounds).toBe(4);
    });

    it('AC-018: a new room never gets the code of an active room @spec:AC-018', () => {
      // first room draws AAAA-AAAA, the second draws it again and must retry
      let draws = 0;
      rooms.draw = () => (draws++ < 16 ? 0 : 1);

      const first = rooms.createRoom(player('ana'), settings());
      const second = rooms.createRoom(player('bia'), settings());

      expect(first.code).toBe('AAAA-AAAA');
      expect(second.code).toBe('BBBB-BBBB');
    });

    it('AC-014: the creator is told about the new room @spec:AC-014', () => {
      const room = rooms.createRoom(player('ana'), settings());

      expect(events).toEqual([
        { type: 'updated', room: expect.objectContaining({ code: room.code }) },
      ]);
    });
  });

  describe('changing settings', () => {
    it('AC-017: the host changes visibility, rounds and size and everyone is told @spec:AC-017', () => {
      const room = rooms.createRoom(player('ana'), settings(4, 'public'));
      rooms.join(player('bia'), room.code);
      events.length = 0;

      const updated = rooms.updateSettings('ana', {
        visibility: 'private',
        rounds: 6,
        size: 8,
      });

      expect(updated.settings).toEqual({
        size: 8,
        visibility: 'private',
        rounds: 6,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'updated',
        room: expect.objectContaining({
          settings: { size: 8, visibility: 'private', rounds: 6 },
        }),
      });
    });

    it('AC-017: a partial change keeps the other settings @spec:AC-017', () => {
      const room = rooms.createRoom(player('ana'), settings(8, 'public', 5));

      const updated = rooms.updateSettings('ana', { rounds: 6 });

      expect(updated.settings).toEqual({
        size: 8,
        visibility: 'public',
        rounds: 6,
      });
      expect(rooms.getRoom(room.code)?.settings.rounds).toBe(6);
    });

    it('AC-017: the size cannot drop below the number of members inside @spec:AC-017', () => {
      const room = rooms.createRoom(player('p1'), settings(8, 'public'));
      for (let i = 2; i <= 5; i++) {
        rooms.join(player(`p${i}`), room.code);
      }
      events.length = 0;

      expectRoomError(
        () => rooms.updateSettings('p1', { size: 4 }),
        'too_many_players_for_size',
        'too many players for this size',
      );
      expect(rooms.getRoom(room.code)?.settings.size).toBe(8);
      expect(events).toEqual([]);
    });

    it('AC-017: invalid new values are refused and nothing changes @spec:AC-017', () => {
      const room = rooms.createRoom(player('ana'), settings(4, 'public', 4));

      expectRoomError(
        () => rooms.updateSettings('ana', { rounds: 9 }),
        'invalid_settings',
        'invalid settings',
      );
      expect(rooms.getRoom(room.code)?.settings.rounds).toBe(4);
    });

    it('AC-017: only the host can change settings @spec:AC-017', () => {
      const room = rooms.createRoom(player('ana'), settings());
      rooms.join(player('bia'), room.code);

      expectRoomError(
        () => rooms.updateSettings('bia', { rounds: 6 }),
        'only_host_can_change_settings',
        'only the host can change settings',
      );
    });

    it('AC-017: settings are frozen once the match started @spec:AC-017', () => {
      const room = fullRoom(4);
      rooms.start('p1');

      expectRoomError(
        () => rooms.updateSettings('p1', { rounds: 6 }),
        'not_in_lobby',
        'the match already started',
      );
      expect(rooms.getRoom(room.code)?.settings.rounds).toBe(4);
    });

    it('AC-017: a player outside any room cannot change settings @spec:AC-017', () => {
      expectRoomError(
        () => rooms.updateSettings('nobody', { rounds: 5 }),
        'not_in_room',
        'you are not in a room',
      );
    });
  });

  describe('listing public rooms', () => {
    it('AC-019: lists only public rooms that still have a free seat @spec:AC-019', () => {
      // 1) waiting, public, free seats
      const waiting = rooms.createRoom(
        player('w1', 'WAITER'),
        settings(8, 'public', 5),
      );
      rooms.join(player('w2'), waiting.code);
      // 2) public but full, still in the lobby
      const full = rooms.createRoom(player('f1'), settings(4, 'public'));
      for (const id of ['f2', 'f3', 'f4']) rooms.join(player(id), full.code);
      // 3) public, match running, no seat left
      const running = rooms.createRoom(player('r1'), settings(4, 'public'));
      for (const id of ['r2', 'r3', 'r4']) rooms.join(player(id), running.code);
      rooms.start('r1');
      // 4) public, match running, a seat opened because someone left
      const open = rooms.createRoom(
        player('o1', 'HOSTO'),
        settings(4, 'public', 6),
      );
      for (const id of ['o2', 'o3', 'o4']) rooms.join(player(id), open.code);
      rooms.start('o1');
      rooms.leave('o4');

      const list = rooms.listPublic();

      expect(list).toEqual([
        {
          code: waiting.code,
          host: 'WAITER',
          players: 2,
          size: 8,
          rounds: 5,
          inMatch: false,
        },
        {
          code: open.code,
          host: 'HOSTO',
          players: 3,
          size: 4,
          rounds: 6,
          inMatch: true,
        },
      ]);
    });

    it('AC-019: an empty list when there is nothing to join @spec:AC-019', () => {
      expect(rooms.listPublic()).toEqual([]);
    });

    it('AC-020: private rooms never show up in the list @spec:AC-020', () => {
      rooms.createRoom(player('ana'), settings(4, 'private'));
      const publicRoom = rooms.createRoom(player('bia'), settings(4, 'public'));

      expect(rooms.listPublic().map((r) => r.code)).toEqual([publicRoom.code]);
    });

    it('AC-020: a room turned private disappears from the list, and back @spec:AC-020', () => {
      const room = rooms.createRoom(player('ana'), settings(4, 'public'));

      rooms.updateSettings('ana', { visibility: 'private' });
      expect(rooms.listPublic()).toEqual([]);
      rooms.updateSettings('ana', { visibility: 'public' });
      expect(rooms.listPublic()).toHaveLength(1);
      expect(rooms.listPublic()[0].code).toBe(room.code);
    });
  });

  describe('joining by code', () => {
    it('AC-021: joining a public or private room with its code @spec:AC-021', () => {
      const publicRoom = rooms.createRoom(player('ana'), settings(4, 'public'));
      const privateRoom = rooms.createRoom(
        player('bia'),
        settings(4, 'private'),
      );

      const a = rooms.join(player('cris'), publicRoom.code);
      const b = rooms.join(player('dani'), privateRoom.code);

      expect(a.members.map((m) => m.sessionId)).toEqual(['ana', 'cris']);
      expect(b.members.map((m) => m.sessionId)).toEqual(['bia', 'dani']);
      expect(rooms.roomOf('cris')?.code).toBe(publicRoom.code);
    });

    it('AC-021: every member receives the updated player list @spec:AC-021', () => {
      const room = rooms.createRoom(player('ana'), settings());
      events.length = 0;

      rooms.join(player('bia', 'BIA'), room.code);

      expect(events).toEqual([
        {
          type: 'updated',
          room: expect.objectContaining({
            code: room.code,
            members: [
              { sessionId: 'ana', nickname: 'ANA', connected: true },
              { sessionId: 'bia', nickname: 'BIA', connected: true },
            ],
          }),
        },
      ]);
    });

    it.each(['abcd-efgh', 'ABCDEFGH', 'abcdefgh'])(
      'AC-022: typing "%s" joins the same room @spec:AC-022',
      (typed) => {
        // draws 0,1,2…7 for the eight letters, so the code is ABCD-EFGH
        let i = 0;
        rooms.draw = () => i++ % 8;
        const room = rooms.createRoom(player('ana'), settings());
        expect(room.code).toBe('ABCD-EFGH');

        const joined = rooms.join(player('bia'), typed);

        expect(joined.code).toBe('ABCD-EFGH');
        expect(joined.members).toHaveLength(2);
      },
    );

    it('AC-023: an unknown code is "room not found" @spec:AC-023', () => {
      rooms.createRoom(player('ana'), settings());

      expectRoomError(
        () => rooms.join(player('bia'), 'ZZZZ-ZZZZ'),
        'room_not_found',
        'room not found',
      );
      expectRoomError(
        () => rooms.join(player('bia'), 'nonsense'),
        'room_not_found',
        'room not found',
      );
      expectRoomError(
        () => rooms.join(player('bia'), undefined),
        'room_not_found',
        'room not found',
      );
    });

    it('AC-024: a full room is "room full" @spec:AC-024', () => {
      const room = fullRoom(4);

      expectRoomError(
        () => rooms.join(player('late'), room.code),
        'room_full',
        'room full',
      );
      expect(rooms.getRoom(room.code)?.members).toHaveLength(4);
    });

    it('AC-025: a running match with no free seat is "match in progress" @spec:AC-025', () => {
      const room = fullRoom(4);
      rooms.start('p1');

      expectRoomError(
        () => rooms.join(player('late'), room.code),
        'match_in_progress',
        'match in progress',
      );
    });

    it('AC-025: a running match with a free seat can be joined @spec:AC-025', () => {
      const room = fullRoom(4);
      rooms.start('p1');
      rooms.leave('p4');

      const joined = rooms.join(player('late'), room.code);

      expect(joined.members.map((m) => m.sessionId)).toEqual([
        'p1',
        'p2',
        'p3',
        'late',
      ]);
    });

    it('AC-026: after 10 wrong codes the player is blocked for a minute @spec:AC-026', () => {
      let now = 5_000_000;
      limiter.clock = () => now;
      const room = rooms.createRoom(player('ana'), settings());

      for (let i = 0; i < 10; i++) {
        expectRoomError(
          () => rooms.join(player('bia'), 'ZZZZ-ZZZZ'),
          'room_not_found',
          'room not found',
        );
      }
      // even the right code is refused while blocked
      expectRoomError(
        () => rooms.join(player('bia'), room.code),
        'too_many_attempts',
        'too many attempts, wait a minute',
      );

      now += 60_001;
      expect(rooms.join(player('bia'), room.code).members).toHaveLength(2);
    });

    it('AC-026: a full or running room does not count as a wrong guess @spec:AC-026', () => {
      const room = fullRoom(4);
      for (let i = 0; i < 15; i++) {
        expectRoomError(
          () => rooms.join(player('late'), room.code),
          'room_full',
          'room full',
        );
      }
      const other = rooms.createRoom(player('ana2'), settings());

      expect(rooms.join(player('late'), other.code).members).toHaveLength(2);
    });

    it('joining the room you are already in changes nothing', () => {
      const room = rooms.createRoom(player('ana'), settings());
      events.length = 0;

      const again = rooms.join(player('ana'), room.code);

      expect(again.members).toHaveLength(1);
      expect(events).toEqual([]);
    });
  });

  describe('starting the match', () => {
    it('AC-027: a room that is not full cannot start @spec:AC-027', () => {
      const room = rooms.createRoom(player('ana'), settings(4));
      rooms.join(player('bia'), room.code);

      expectRoomError(
        () => rooms.start('ana'),
        'room_not_full',
        'room not full',
      );
      expect(rooms.getRoom(room.code)?.phase).toBe('lobby');
    });

    it('AC-027: a full room starts the match for every member @spec:AC-027', () => {
      const room = fullRoom(4);
      events.length = 0;

      const started = rooms.start('p1');

      expect(started.phase).toBe('match');
      expect(events).toEqual([
        {
          type: 'started',
          room: expect.objectContaining({ code: room.code, phase: 'match' }),
        },
        {
          type: 'updated',
          room: expect.objectContaining({ code: room.code, phase: 'match' }),
        },
      ]);
    });

    it('AC-027: a room of 8 needs all 8 @spec:AC-027', () => {
      const room = rooms.createRoom(player('p1'), settings(8));
      for (let i = 2; i <= 7; i++) rooms.join(player(`p${i}`), room.code);
      expectRoomError(
        () => rooms.start('p1'),
        'room_not_full',
        'room not full',
      );

      rooms.join(player('p8'), room.code);

      expect(rooms.start('p1').phase).toBe('match');
    });

    it('AC-028: only the host can start @spec:AC-028', () => {
      fullRoom(4);

      expectRoomError(
        () => rooms.start('p2'),
        'only_host_can_start',
        'only the host can start',
      );
    });

    it('a match cannot be started twice', () => {
      fullRoom(4);
      rooms.start('p1');

      expectRoomError(
        () => rooms.start('p1'),
        'not_in_lobby',
        'the match already started',
      );
    });
  });

  describe('leaving', () => {
    it('AC-029: leaving removes the player and tells the others @spec:AC-029', () => {
      const room = rooms.createRoom(player('ana'), settings());
      rooms.join(player('bia'), room.code);
      rooms.join(player('cris'), room.code);
      events.length = 0;

      rooms.leave('bia');

      expect(rooms.getRoom(room.code)?.members.map((m) => m.sessionId)).toEqual(
        ['ana', 'cris'],
      );
      expect(rooms.roomOf('bia')).toBeUndefined();
      expect(events).toEqual([
        {
          type: 'updated',
          room: expect.objectContaining({
            members: [
              expect.objectContaining({ sessionId: 'ana' }),
              expect.objectContaining({ sessionId: 'cris' }),
            ],
          }),
        },
      ]);
    });

    it('AC-030: when the host leaves, the longest-standing member becomes host @spec:AC-030', () => {
      const room = rooms.createRoom(player('ana'), settings());
      rooms.join(player('bia'), room.code);
      rooms.join(player('cris'), room.code);
      events.length = 0;

      rooms.leave('ana');

      expect(rooms.getRoom(room.code)?.hostId).toBe('bia');
      expect(events).toEqual([
        { type: 'updated', room: expect.objectContaining({ hostId: 'bia' }) },
      ]);
    });

    it('AC-030: a host that is not the one who leaves keeps the role @spec:AC-030', () => {
      const room = rooms.createRoom(player('ana'), settings());
      rooms.join(player('bia'), room.code);

      rooms.leave('bia');

      expect(rooms.getRoom(room.code)?.hostId).toBe('ana');
    });

    it('AC-031: the last player leaving deletes the room @spec:AC-031', () => {
      const room = rooms.createRoom(player('ana'), settings());
      events.length = 0;

      rooms.leave('ana');

      expect(rooms.count()).toBe(0);
      expect(rooms.getRoom(room.code)).toBeUndefined();
      expect(rooms.listPublic()).toEqual([]);
      expectRoomError(
        () => rooms.join(player('bia'), room.code),
        'room_not_found',
        'room not found',
      );
      expect(events).toEqual([{ type: 'deleted', code: room.code }]);
    });

    it('leaving when you are in no room is refused', () => {
      expectRoomError(
        () => rooms.leave('nobody'),
        'not_in_room',
        'you are not in a room',
      );
    });

    it('a leaving player can join another room afterwards', () => {
      const a = rooms.createRoom(player('ana'), settings());
      const b = rooms.createRoom(player('bia'), settings());
      rooms.join(player('cris'), a.code);
      rooms.leave('cris');

      expect(rooms.join(player('cris'), b.code).members).toHaveLength(2);
    });
  });

  describe('one room at a time', () => {
    it('AC-033: creating a room leaves the previous one first @spec:AC-033', () => {
      const first = rooms.createRoom(player('ana'), settings());
      rooms.join(player('bia'), first.code);
      events.length = 0;

      const second = rooms.createRoom(player('bia'), settings());

      expect(
        rooms.getRoom(first.code)?.members.map((m) => m.sessionId),
      ).toEqual(['ana']);
      expect(rooms.roomOf('bia')?.code).toBe(second.code);
      // the old room is told first, then the new one
      expect(events.map((e) => e.type)).toEqual(['updated', 'updated']);
      expect((events[0] as any).room.code).toBe(first.code);
      expect((events[1] as any).room.code).toBe(second.code);
    });

    it('AC-033: joining a room leaves the previous one, with the same effects as leaving @spec:AC-033', () => {
      const first = rooms.createRoom(player('ana'), settings());
      rooms.join(player('bia'), first.code);
      const second = rooms.createRoom(player('cris'), settings());
      events.length = 0;

      // the host of the first room moves away: host passes to bia, and a solo room disappears
      rooms.join(player('ana'), second.code);

      expect(rooms.getRoom(first.code)?.hostId).toBe('bia');
      expect(rooms.roomOf('ana')?.code).toBe(second.code);
    });

    it('AC-033: leaving the only seat of the previous room deletes it @spec:AC-033', () => {
      const first = rooms.createRoom(player('ana'), settings());
      const second = rooms.createRoom(player('bia'), settings());

      rooms.join(player('ana'), second.code);

      expect(rooms.getRoom(first.code)).toBeUndefined();
      expect(rooms.count()).toBe(1);
    });

    it('AC-033: a failed join does not throw you out of your current room @spec:AC-033', () => {
      const room = rooms.createRoom(player('ana'), settings());

      expectRoomError(
        () => rooms.join(player('ana'), 'ZZZZ-ZZZZ'),
        'room_not_found',
        'room not found',
      );
      expectRoomError(
        () => rooms.createRoom(player('ana'), { size: 5 }),
        'invalid_settings',
        'invalid settings',
      );

      expect(rooms.roomOf('ana')?.code).toBe(room.code);
    });
  });

  describe('what other players may see', () => {
    it('AC-005: room views carry public ids and nicknames, nothing else @spec:AC-005', () => {
      const room = rooms.createRoom(player('ana'), settings());
      rooms.join(player('bia'), room.code);

      const view = rooms.viewOf(rooms.getRoom(room.code)!);

      expect(Object.keys(view).sort()).toEqual([
        'code',
        'hostId',
        'members',
        'phase',
        'settings',
      ]);
      for (const member of view.members) {
        expect(Object.keys(member).sort()).toEqual([
          'connected',
          'nickname',
          'sessionId',
        ]);
      }
    });
  });
});
