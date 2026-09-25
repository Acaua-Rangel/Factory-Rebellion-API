import { GameMap, Rect } from './map';
import { Point } from './match.types';

// The movement of the local game (scripts/move.gml), run by the server.
export const SPEED = 4; // px per frame
export const GRAVITY = 0.4;
export const JUMP_SPEED = 11.1;

// Safety net for the "walk until touching" loops (a body stuck in geometry).
const MAX_LOOP = 10_000;

// What a player can ask for in one frame. Only these four keys are ever read:
// anything else a client adds to its input is ignored (AC-062).
export interface Input {
  left: boolean;
  right: boolean;
  // true only on the frame the key was pressed (key_jump is an edge)
  jump: boolean;
  down: boolean;
}

export interface Body {
  x: number;
  y: number;
  hspd: number;
  vspd: number;
  // 1 = facing right, -1 = facing left
  facing: 1 | -1;
  // the "down" key of the previous frame (obj_player.fall)
  fall: boolean;
  // per collider of the map: does it block THIS player right now? Solid
  // colliders always do; one-way ones switch depending on where the player is,
  // exactly as their Step code toggles sprite_index in the game.
  solid: boolean[];
}

export type Animation = 'idle' | 'walk' | 'jump' | 'fall';

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

export class Physics {
  constructor(private readonly map: GameMap) {}

  createBody(at: Point): Body {
    return {
      x: at.x,
      y: at.y,
      hspd: 0,
      vspd: 0,
      facing: 1,
      fall: false,
      // one-way colliders start non-solid (Create sets sprite_index = -1)
      solid: this.map.colliders.map((c) => c.kind === 'solid'),
    };
  }

  // One frame (1/60 s) of a player.
  step(body: Body, input: Input): void {
    this.updateOneWayColliders(body);

    body.fall = input.down === true;
    const move = (input.right === true ? 1 : 0) - (input.left === true ? 1 : 0);

    body.hspd = move * SPEED;
    body.vspd += GRAVITY;

    if (body.hspd !== 0) {
      body.facing = body.hspd > 0 ? 1 : -1;
    }

    // jump
    if (this.meeting(body, body.x, body.y + 1) && input.jump === true) {
      body.vspd -= JUMP_SPEED;
    }

    // horizontal collision
    if (this.meeting(body, body.x + body.hspd, body.y)) {
      for (
        let n = 0;
        !this.meeting(body, body.x + sign(body.hspd), body.y) && n < MAX_LOOP;
        n++
      ) {
        body.x += sign(body.hspd);
      }
      body.hspd = 0;
    }
    body.x += body.hspd;

    // vertical collision
    if (this.meeting(body, body.x, body.y + body.vspd)) {
      for (
        let n = 0;
        !this.meeting(body, body.x, body.y + sign(body.vspd)) && n < MAX_LOOP;
        n++
      ) {
        body.y += sign(body.vspd);
      }
      body.vspd = 0;
    }
    body.y += body.vspd;
  }

  onGround(body: Body): boolean {
    return this.meeting(body, body.x, body.y + 1);
  }

  // Which animation the client should play (scripts/anim_move.gml).
  animationOf(body: Body): Animation {
    if (this.onGround(body)) {
      return body.hspd !== 0 && body.vspd === 0 ? 'walk' : 'idle';
    }
    return body.vspd < 0 ? 'jump' : 'fall';
  }

  // The Step code of every one-way collider, for this player: it exists while
  // its edge is not above the player's feet and the player is not pressing
  // down. Uses where the player ended the previous frame, which is what the
  // game sees whichever order the instances run in.
  private updateOneWayColliders(body: Body): void {
    const feet = Math.round(body.y) + this.map.playerMask.bottom;
    this.map.colliders.forEach((collider, i) => {
      if (collider.kind === 'solid') {
        return;
      }
      const wasSolid = body.solid[i];
      if (collider.kind === 'oneway_top') {
        const top = wasSolid
          ? collider.rect.top
          : (collider.idleEdge ?? collider.rect.top);
        body.solid[i] = top >= feet - 1 && !body.fall;
      } else {
        const bottom = wasSolid
          ? collider.rect.bottom
          : (collider.idleEdge ?? collider.rect.bottom);
        body.solid[i] = bottom >= feet && !body.fall;
      }
    });
  }

  // place_meeting(px, py, obj_collision) for this player: GameMaker rounds
  // sub-pixel positions (ASM-036) and compares inclusive pixel boxes.
  private meeting(body: Body, px: number, py: number): boolean {
    const mask = this.map.playerMask;
    const x = Math.round(px);
    const y = Math.round(py);
    const box: Rect = {
      left: x + mask.left,
      right: x + mask.right,
      top: y + mask.top,
      bottom: y + mask.bottom,
    };
    return this.map.colliders.some(
      (collider, i) =>
        body.solid[i] &&
        box.left <= collider.rect.right &&
        box.right >= collider.rect.left &&
        box.top <= collider.rect.bottom &&
        box.bottom >= collider.rect.top,
    );
  }
}
