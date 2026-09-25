import { Point, Team } from './match.types';
import multiplayer1 from '../assets/maps/multiplayer1.json';

// Pixel edges, inclusive, like GameMaker's bbox_left/right/top/bottom.
export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// solid: always blocks · oneway_top: a platform that only exists for a player
// whose feet are above its top and who is not pressing down · oneway_bottom:
// the ropes, which exist while their bottom is below the player's feet.
export type ColliderKind = 'solid' | 'oneway_top' | 'oneway_bottom';

export interface Collider {
  id: string;
  object: string;
  kind: ColliderKind;
  // where the collider is when it is solid
  rect: Rect;
  // where GameMaker sees it while it is NOT solid (a mask-less instance sits
  // at its own position); only for one-way colliders
  idleEdge?: number;
}

export interface MapMachine {
  id: string;
  object: string;
  // the collider that is this machine's body
  collider: string;
}

export interface GameMap {
  name: string;
  width: number;
  height: number;
  // the player's collision box relative to its position (x, y); it does not
  // change when the player turns around
  playerMask: Rect;
  colliders: Collider[];
  machines: MapMachine[];
  spawns: Record<Team, Point[]>;
}

// The map exported from the GameMaker room (scripts/export-map.ts).
export function loadMap(): GameMap {
  return multiplayer1 as GameMap;
}
