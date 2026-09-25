import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { buildMap, ExportInput, parseGameMakerJson } from './map-export';
import { GameMap, loadMap } from './map';

// A tiny GameMaker project: a scaled floor, a wall, a one-way platform, a
// machine, a rope and a chair placed with a negative scale.
const sprite = (
  width: number,
  height: number,
  xorigin: number,
  yorigin: number,
  bbox: [number, number, number, number],
) => ({
  width,
  height,
  xorigin,
  yorigin,
  bbox_left: bbox[0],
  bbox_right: bbox[1],
  bbox_top: bbox[2],
  bbox_bottom: bbox[3],
});

const fixture = (): ExportInput => ({
  room: {
    name: 'Test',
    width: 2048,
    height: 1024,
    instances: [
      {
        object: 'obj_chao',
        name: 'floor',
        x: 1024.5,
        y: 1022,
        scaleX: 2,
        scaleY: 1.2,
      },
      {
        object: 'obj_wall',
        name: 'wall',
        x: -32,
        y: 487,
        scaleX: 2,
        scaleY: 31.56,
      },
      {
        object: 'obj_tampo',
        name: 'barrel',
        x: 981,
        y: 404,
        scaleX: 1,
        scaleY: 1,
      },
      {
        object: 'obj_maquina2',
        name: 'm2',
        x: 1382,
        y: 796,
        scaleX: 1,
        scaleY: 1,
      },
      {
        object: 'obj_maquina1',
        name: 'm1',
        x: 813,
        y: 300,
        scaleX: 1,
        scaleY: 1,
      },
      {
        object: 'obj_corda',
        name: 'rope',
        x: 1024,
        y: 732,
        scaleX: 1.02,
        scaleY: 1,
      },
      {
        object: 'obj_cadeira',
        name: 'chair',
        x: 1885,
        y: 905,
        scaleX: -1.57,
        scaleY: 1.38,
      },
      {
        object: 'obj_camera',
        name: 'cam',
        x: 160,
        y: 64,
        scaleX: 1,
        scaleY: 1,
      },
      {
        object: 'obj_player',
        name: 'player',
        x: 870,
        y: 692,
        scaleX: 4.33,
        scaleY: 4.33,
      },
    ],
  },
  objects: {
    obj_collision: { parent: null, sprite: null, stepCode: undefined },
    obj_chao: {
      parent: 'obj_collision',
      sprite: 'spr_chao',
      stepCode: undefined,
    },
    obj_wall: {
      parent: 'obj_collision',
      sprite: 'srp_wall',
      stepCode: undefined,
    },
    obj_tampo: {
      parent: 'obj_collision',
      sprite: 'spr_tambores',
      stepCode:
        'if (bbox_top >= obj_player.bbox_bottom-1) and (obj_player.fall==false){\r\n\tsprite_index = spr_tambores;\r\n} else {\r\n\tsprite_index = -1;\r\n}',
    },
    obj_maquina1: {
      parent: 'obj_collision',
      sprite: 'spr_maquina1',
      stepCode:
        'if (bbox_top >= obj_player.bbox_bottom-1) and (obj_player.fall==false){ sprite_index = spr_maquina1; } else { sprite_index = -1; }',
    },
    obj_maquina2: {
      parent: 'obj_collision',
      sprite: 'spr_maquina2',
      stepCode:
        'if (bbox_top >= obj_player.bbox_bottom-1) and (obj_player.fall==false){ sprite_index = spr_maquina2; } else { sprite_index = -1; }',
    },
    obj_corda: {
      parent: 'obj_collision',
      sprite: 'spr_cabo',
      stepCode:
        'if (bbox_bottom >= obj_player.bbox_bottom) and (obj_player.fall==false){ sprite_index = spr_cabo; } else { sprite_index = -1; }',
    },
    obj_cadeira: {
      parent: 'obj_collision',
      sprite: 'spr_cadeira',
      stepCode:
        'if (bbox_top >= obj_player.bbox_bottom-1) and (obj_player.fall==false){ sprite_index = spr_cadeira; } else { sprite_index = -1; }',
    },
    obj_camera: {
      parent: null,
      sprite: null,
      stepCode: 'x = lerp(x, target_.x, 0.1);',
    },
    obj_player: { parent: null, sprite: 'spr_dono_idle', stepCode: 'move();' },
  },
  sprites: {
    spr_chao: sprite(1024, 104, 512, 52, [0, 1023, 0, 103]),
    srp_wall: sprite(32, 32, 16, 16, [0, 31, 0, 31]),
    spr_tambores: sprite(84, 64, 0, 4, [0, 79, 4, 63]),
    spr_maquina1: sprite(324, 252, 72, 88, [64, 207, 88, 251]),
    spr_maquina2: sprite(608, 212, 92, 48, [88, 523, 52, 211]),
    spr_cabo: sprite(2000, 16, 1000, 0, [0, 1999, 0, 15]),
    spr_cadeira: sprite(56, 84, 28, 44, [0, 55, 44, 83]),
    spr_dono_idle: sprite(128, 128, 76, 64, [48, 103, 8, 127]),
  },
  spawns: {
    workers: [
      { x: 100, y: 896 },
      { x: 160, y: 896 },
      { x: 220, y: 896 },
      { x: 280, y: 896 },
    ],
    capatazes: [
      { x: 2000, y: 400 },
      { x: 1960, y: 400 },
      { x: 1920, y: 400 },
      { x: 1880, y: 400 },
    ],
  },
});

describe('parseGameMakerJson', () => {
  it('reads GameMaker .yy files, which are JSON with trailing commas', () => {
    expect(parseGameMakerJson('{"a":[1,2,],"b":{"c":3,},}')).toEqual({
      a: [1, 2],
      b: { c: 3 },
    });
  });
});

describe('Map export', () => {
  const map = () => buildMap(fixture());
  const collider = (m: GameMap, object: string) =>
    m.colliders.find((c) => c.object === object)!;

  it('AC-061: the room size and name are carried over', () => {
    expect(map()).toMatchObject({ name: 'Test', width: 2048, height: 1024 });
  });

  it('AC-061: solid objects (no Step code) are always solid; their rectangle follows scale and origin @spec:AC-061', () => {
    const wall = collider(map(), 'obj_wall');

    // x: -32 + (0-16)*2 = -64 .. -32 + (32-16)*2 = 0 (exclusive) ; y: 487 - 16*31.56 = -18 .. 992
    expect(wall.kind).toBe('solid');
    expect(wall.rect).toEqual({ left: -64, right: -1, top: -18, bottom: 991 });
  });

  it('AC-061: the floor uses the sprite bounding box scaled around its origin @spec:AC-061', () => {
    const floor = collider(map(), 'obj_chao');

    // top 1022 + (0-52)*1.2 = 959.6 -> 960 ; bottom (exclusive) 1022 + (104-52)*1.2 = 1084.4 -> 1084
    expect(floor.kind).toBe('solid');
    expect(floor.rect.top).toBe(960);
    expect(floor.rect.bottom).toBe(1083);
  });

  it('AC-061: a Step that tests bbox_top against the player is a one-way platform, solid from above @spec:AC-061', () => {
    const barrel = collider(map(), 'obj_tampo');

    expect(barrel.kind).toBe('oneway_top');
    // sprite origin y=4, bbox top=4: the platform surface is the instance y
    expect(barrel.rect.top).toBe(404);
    expect(barrel.idleEdge).toBe(404);
  });

  it('AC-061: a sprite whose top is not at its origin keeps a different solid edge than its idle one @spec:AC-061', () => {
    const machine2 = collider(map(), 'obj_maquina2');

    // origin y=48, bbox top=52: solid top is y+4, but a mask-less instance sits at y
    expect(machine2.kind).toBe('oneway_top');
    expect(machine2.rect.top).toBe(800);
    expect(machine2.idleEdge).toBe(796);
  });

  it('AC-061: a Step that tests bbox_bottom is the rope: solid while its bottom is below the feet @spec:AC-061', () => {
    const rope = collider(map(), 'obj_corda');

    expect(rope.kind).toBe('oneway_bottom');
    expect(rope.rect.bottom).toBe(747); // y + 16 - 1
    expect(rope.idleEdge).toBe(732);
  });

  it('AC-061: a negative scale mirrors the rectangle around the origin @spec:AC-061', () => {
    const chair = collider(map(), 'obj_cadeira');

    // x: 1885 + (0-28)*-1.57 = 1928.96 .. 1885 + (56-28)*-1.57 = 1841.04
    expect(chair.rect.left).toBe(1841);
    expect(chair.rect.right).toBe(1928);
  });

  it('AC-061: objects that are not collision objects (camera, player) are not colliders @spec:AC-061', () => {
    const objects = map().colliders.map((c) => c.object);

    expect(objects).not.toContain('obj_camera');
    expect(objects).not.toContain('obj_player');
  });

  it('AC-061: the player mask comes from the player sprite, relative to its position @spec:AC-061', () => {
    expect(map().playerMask).toEqual({
      left: -28,
      right: 27,
      top: -56,
      bottom: 63,
    });
  });

  it('AC-061: machines are listed in room order with stable ids and point to their collider @spec:AC-061', () => {
    const m = map();

    expect(m.machines.map((x) => x.id)).toEqual(['machine1', 'machine2']);
    expect(m.machines.map((x) => x.object)).toEqual([
      'obj_maquina2',
      'obj_maquina1',
    ]);
    for (const machine of m.machines) {
      expect(m.colliders.find((c) => c.id === machine.collider)?.object).toBe(
        machine.object,
      );
    }
  });

  it('AC-061: every collider has a unique id', () => {
    const ids = map().colliders.map((c) => c.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('spawns are carried over as given', () => {
    expect(map().spawns).toEqual(fixture().spawns);
  });

  it('refuses a collision object whose Step code it does not understand, instead of guessing', () => {
    const input = fixture();
    input.objects.obj_tampo.stepCode =
      'sprite_index = spr_tambores; // something new';

    expect(() => buildMap(input)).toThrow(/obj_tampo/);
  });

  it('refuses a player mask that changes when the sprite is flipped', () => {
    const input = fixture();
    input.sprites.spr_dono_idle = sprite(128, 128, 76, 64, [40, 103, 8, 127]);

    expect(() => buildMap(input)).toThrow(/symmetric/i);
  });

  it('refuses a map with fewer than 4 spawns per team', () => {
    const input = fixture();
    input.spawns.workers = input.spawns.workers.slice(0, 3);

    expect(() => buildMap(input)).toThrow(/spawn/i);
  });

  it('refuses a map with no machines', () => {
    const input = fixture();
    input.room.instances = input.room.instances.filter(
      (i) => !i.object.startsWith('obj_maquina'),
    );

    expect(() => buildMap(input)).toThrow(/machine/i);
  });
});

describe('The exported Multiplayer1 map', () => {
  const map = loadMap();

  it('AC-061: has the 7 machines of the room (4 of type 1, 1 of type 2, 2 of type 3) @spec:AC-061', () => {
    const counts: Record<string, number> = {};
    for (const machine of map.machines)
      counts[machine.object] = (counts[machine.object] ?? 0) + 1;

    expect(map.machines).toHaveLength(7);
    expect(counts).toEqual({
      obj_maquina1: 4,
      obj_maquina2: 1,
      obj_maquina3: 2,
    });
  });

  it('AC-061: has 4 spawn points per team, inside the room, with workers low-left and capatazes high-right @spec:AC-061', () => {
    for (const team of ['workers', 'capatazes'] as const) {
      expect(map.spawns[team]).toHaveLength(4);
      for (const p of map.spawns[team]) {
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(map.width);
      }
    }
    expect(Math.max(...map.spawns.workers.map((p) => p.x))).toBeLessThan(
      map.width / 4,
    );
    expect(Math.min(...map.spawns.capatazes.map((p) => p.x))).toBeGreaterThan(
      (map.width * 3) / 4,
    );
    expect(Math.min(...map.spawns.workers.map((p) => p.y))).toBeGreaterThan(
      Math.max(...map.spawns.capatazes.map((p) => p.y)),
    );
  });

  it('AC-061: the walls and the floor are solid, the platforms one-way @spec:AC-061', () => {
    const kinds = new Set(
      map.colliders
        .filter((c) => c.object === 'obj_wall' || c.object === 'obj_chao')
        .map((c) => c.kind),
    );

    expect(kinds).toEqual(new Set(['solid']));
    expect(
      map.colliders
        .filter((c) => c.object === 'obj_maquina1')
        .every((c) => c.kind === 'oneway_top'),
    ).toBe(true);
    expect(
      map.colliders
        .filter((c) => c.object === 'obj_corda')
        .every((c) => c.kind === 'oneway_bottom'),
    ).toBe(true);
  });

  it('AC-061: the room is 2048 x 1024 and the player mask is the Owner idle sprite @spec:AC-061', () => {
    expect([map.width, map.height]).toEqual([2048, 1024]);
    expect(map.playerMask).toEqual({
      left: -28,
      right: 27,
      top: -56,
      bottom: 63,
    });
  });

  // The committed JSON must be what the exporter produces from the real game
  // project. Only runs when the game repository sits next to the API one.
  const gameDir = path.resolve(__dirname, '../../../Factory Rebellion Game');
  const whenGameIsHere = existsSync(gameDir) ? it : it.skip;

  whenGameIsHere(
    'the committed map is up to date with the GameMaker project (no drift)',
    () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { exportFromProject } = require('./map-export');
      const spawns = JSON.parse(
        readFileSync(
          path.resolve(__dirname, '../assets/maps/multiplayer1.spawns.json'),
          'utf8',
        ),
      );

      expect(exportFromProject(gameDir, 'Multiplayer1', spawns)).toEqual(map);
    },
  );
});
