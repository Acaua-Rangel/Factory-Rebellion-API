import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { Collider, ColliderKind, GameMap, Rect } from './map';
import { Point } from './match.types';

// GameMaker's .yy/.yyp files are JSON with trailing commas.
export function parseGameMakerJson(text: string): any {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

export interface SpriteInfo {
  width: number;
  height: number;
  xorigin: number;
  yorigin: number;
  bbox_left: number;
  bbox_right: number;
  bbox_top: number;
  bbox_bottom: number;
}

export interface ObjectInfo {
  parent: string | null;
  sprite: string | null;
  stepCode?: string;
}

export interface RoomInstance {
  object: string;
  name: string;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export interface ExportInput {
  room: {
    name: string;
    width: number;
    height: number;
    instances: RoomInstance[];
  };
  objects: Record<string, ObjectInfo>;
  sprites: Record<string, SpriteInfo>;
  spawns: { workers: Point[]; capatazes: Point[] };
}

const COLLISION_ROOT = 'obj_collision';
const MACHINE = /^obj_maquina\d+$/;

// The Step code of a one-way platform tests its own bounding box against the
// player's feet. Reading the code (instead of a hand-kept list) keeps the map
// in sync with the game, and an object it does not understand is an error.
function kindOf(object: string, stepCode: string | undefined): ColliderKind {
  if (stepCode === undefined || stepCode.trim() === '') {
    return 'solid';
  }
  if (/bbox_top\s*>=\s*obj_player\.bbox_bottom\s*-\s*1/.test(stepCode)) {
    return 'oneway_top';
  }
  if (/bbox_bottom\s*>=\s*obj_player\.bbox_bottom(?!\s*-)/.test(stepCode)) {
    return 'oneway_bottom';
  }
  throw new Error(
    `${object}: cannot tell how this collision object behaves from its Step code; teach map-export.ts about it`,
  );
}

function isCollider(object: string, objects: ExportInput['objects']): boolean {
  for (
    let name: string | null = object, guard = 0;
    name && guard < 20;
    guard++
  ) {
    if (name === COLLISION_ROOT) {
      return object !== COLLISION_ROOT;
    }
    name = objects[name]?.parent ?? null;
  }
  return false;
}

// The instance's box in room pixels, scaled around the sprite origin. GameMaker
// rounds sub-pixel positions (ASM-036), so the edges are rounded here; a
// negative scale mirrors the box.
function rectOf(instance: RoomInstance, sprite: SpriteInfo): Rect {
  const edge = (
    pos: number,
    low: number,
    high: number,
    origin: number,
    scale: number,
  ) => {
    const a = pos + (low - origin) * scale;
    const b = pos + (high + 1 - origin) * scale;
    // "+ 0" turns a rounded -0 into 0 (JSON cannot hold a negative zero)
    return [Math.round(Math.min(a, b)) + 0, Math.round(Math.max(a, b)) - 1 + 0];
  };
  const [left, right] = edge(
    instance.x,
    sprite.bbox_left,
    sprite.bbox_right,
    sprite.xorigin,
    instance.scaleX,
  );
  const [top, bottom] = edge(
    instance.y,
    sprite.bbox_top,
    sprite.bbox_bottom,
    sprite.yorigin,
    instance.scaleY,
  );
  return { left, right, top, bottom };
}

// The player's box relative to its position. The server ignores which way the
// player faces, so the box must not change when the sprite is flipped.
function playerMaskOf(sprite: SpriteInfo): Rect {
  const mask = {
    left: sprite.bbox_left - sprite.xorigin,
    right: sprite.bbox_right - sprite.xorigin,
    top: sprite.bbox_top - sprite.yorigin,
    bottom: sprite.bbox_bottom - sprite.yorigin,
  };
  if (mask.left !== -(mask.right + 1)) {
    throw new Error(
      `the player mask is not horizontally symmetric (${mask.left}..${mask.right}): flipping the sprite would change collisions`,
    );
  }
  return mask;
}

export function buildMap(input: ExportInput): GameMap {
  const colliders: Collider[] = [];
  const machines: GameMap['machines'] = [];

  for (const instance of input.room.instances) {
    if (!isCollider(instance.object, input.objects)) {
      continue;
    }
    const info = input.objects[instance.object];
    const sprite = info.sprite && input.sprites[info.sprite];
    if (!sprite) {
      throw new Error(
        `${instance.object}: no sprite to take a collision box from`,
      );
    }
    const kind = kindOf(instance.object, info.stepCode);
    const collider: Collider = {
      id: `c${colliders.length + 1}`,
      object: instance.object,
      kind,
      rect: rectOf(instance, sprite),
    };
    if (kind !== 'solid') {
      collider.idleEdge = instance.y;
    }
    colliders.push(collider);

    if (MACHINE.test(instance.object)) {
      machines.push({
        id: `machine${machines.length + 1}`,
        object: instance.object,
        collider: collider.id,
      });
    }
  }

  if (machines.length === 0) {
    throw new Error(
      'the room has no machines (obj_maquina*): nothing to break',
    );
  }
  for (const team of ['workers', 'capatazes'] as const) {
    if (input.spawns[team].length < 4) {
      throw new Error(
        `need at least 4 spawn points for ${team} (a team has up to 4 players)`,
      );
    }
  }

  const playerSprite = input.objects.obj_player?.sprite;
  if (!playerSprite || !input.sprites[playerSprite]) {
    throw new Error('obj_player has no sprite: cannot take the player mask');
  }

  return {
    name: input.room.name,
    width: input.room.width,
    height: input.room.height,
    playerMask: playerMaskOf(input.sprites[playerSprite]),
    colliders,
    machines,
    spawns: input.spawns,
  };
}

// ---- reading a real GameMaker project ---------------------------------------

function collectInstances(layers: any[], out: RoomInstance[]): void {
  for (const layer of layers) {
    for (const i of layer.instances ?? []) {
      out.push({
        object: i.objectId.name,
        name: i.name,
        x: i.x,
        y: i.y,
        scaleX: i.scaleX,
        scaleY: i.scaleY,
      });
    }
    collectInstances(layer.layers ?? [], out);
  }
}

export function exportFromProject(
  projectDir: string,
  roomName: string,
  spawns: ExportInput['spawns'],
): GameMap {
  const read = (...parts: string[]) =>
    readFileSync(path.join(projectDir, ...parts), 'utf8');
  const room = parseGameMakerJson(read('rooms', roomName, `${roomName}.yy`));

  const instances: RoomInstance[] = [];
  collectInstances(room.layers, instances);

  const objects: ExportInput['objects'] = {};
  const sprites: ExportInput['sprites'] = {};
  const loadObject = (name: string): void => {
    if (objects[name]) {
      return;
    }
    const yy = parseGameMakerJson(read('objects', name, `${name}.yy`));
    const stepFile = path.join(projectDir, 'objects', name, 'Step_0.gml');
    objects[name] = {
      parent: yy.parentObjectId?.name ?? null,
      sprite: yy.spriteId?.name ?? null,
      stepCode: existsSync(stepFile)
        ? readFileSync(stepFile, 'utf8')
        : undefined,
    };
    if (objects[name].parent) {
      loadObject(objects[name].parent as string);
    }
    const sprite = objects[name].sprite;
    if (sprite && !sprites[sprite]) {
      const s = parseGameMakerJson(read('sprites', sprite, `${sprite}.yy`));
      sprites[sprite] = {
        width: s.width,
        height: s.height,
        xorigin: s.sequence.xorigin,
        yorigin: s.sequence.yorigin,
        bbox_left: s.bbox_left,
        bbox_right: s.bbox_right,
        bbox_top: s.bbox_top,
        bbox_bottom: s.bbox_bottom,
      };
    }
  };
  for (const name of new Set(instances.map((i) => i.object))) {
    loadObject(name);
  }

  return buildMap({
    room: {
      name: roomName,
      width: room.roomSettings.Width,
      height: room.roomSettings.Height,
      instances,
    },
    objects,
    sprites,
    spawns,
  });
}
