import { GameMap, Rect } from './map';
import { Match } from './match-state';
import { MatchPlayer, Role, Team } from './match.types';
import { AppliedInput, Simulation } from './simulation';

// Only the server decides who is hit and by how much (AC-058). Everything is
// in half-hearts: a player has 6 (ASM-018).
export const SHOT_DAMAGE = 1;
export const MELEE_DAMAGE = 2;
export const PISTOL_COOLDOWN = 10; // frames (ASM-019)
export const MELEE_COOLDOWN = 30; // ~0.5 s
export const BULLET_SPEED = 10; // px per frame
export const MELEE_REACH = 56; // px beyond the attacker's box, in front (ASM-041)
export const HIT_ANIM_FRAMES = 20; // how long others see the hit animation
export const REVIVE_FRAMES = 180; // 3 s holding the key (ASM-026)
const REVIVE_REACH_X = 56; // px around the reviver's box
const REVIVE_REACH_Y = 16;
const MUZZLE_AHEAD = 8; // px in front of the body's edge
const MUZZLE_DROP = 6; // px below the body's position (as the pistol sits)
const BULLET_HALF = 2; // the bullet is a 5 x 5 box

export interface Bullet {
  id: number;
  ownerId: string;
  team: Team;
  x: number;
  y: number;
  dir: 1 | -1;
}

export interface MeleeEvent {
  attackerId: string;
  role: Role;
  // the box the attack covers, in room pixels
  rect: Rect;
}

// The player holds interact and there is nobody to revive: whatever else can
// be done with the key (the Owner repairing a machine) happens here.
export interface InteractEvent {
  playerId: string;
  role: Role;
  // the box around the player that "within reach" means
  reach: Rect;
}

interface Revive {
  target: string;
  frames: number;
}

const overlaps = (a: Rect, b: Rect) =>
  a.left <= b.right &&
  a.right >= b.left &&
  a.top <= b.bottom &&
  a.bottom >= b.top;

// Attacks, bullets and revives of one match. The game loop feeds it the input
// each player applied this frame (act) and then advances the world (frame).
export class Combat {
  private readonly cooldown = new Map<string, number>();
  private readonly revives = new Map<string, Revive>();
  private readonly hitUntil = new Map<string, number>();
  private readonly meleeListeners: ((event: MeleeEvent) => void)[] = [];
  private readonly interactListeners: ((event: InteractEvent) => void)[] = [];
  private live: Bullet[] = [];
  private nextBullet = 1;
  private frameNo = 0;

  constructor(
    private readonly map: GameMap,
    private readonly match: Match,
    private readonly sim: Simulation,
  ) {}

  get bullets(): readonly Bullet[] {
    return this.live;
  }

  onMelee(listener: (event: MeleeEvent) => void): void {
    this.meleeListeners.push(listener);
  }

  onInteract(listener: (event: InteractEvent) => void): void {
    this.interactListeners.push(listener);
  }

  // 'hit' while a melee attack is fresh, so other players can show it.
  animOf(sessionId: string): 'hit' | undefined {
    return this.frameNo < (this.hitUntil.get(sessionId) ?? 0)
      ? 'hit'
      : undefined;
  }

  // 0..1: how far along the revive of this downed player is.
  reviveProgress(sessionId: string): number {
    let best = 0;
    for (const revive of this.revives.values()) {
      if (revive.target === sessionId) {
        best = Math.max(best, revive.frames / REVIVE_FRAMES);
      }
    }
    return Math.min(best, 1);
  }

  // A new round: nothing from the last one survives.
  resetRound(): void {
    this.live = [];
    this.cooldown.clear();
    this.revives.clear();
    this.hitUntil.clear();
  }

  forget(sessionId: string): void {
    this.cooldown.delete(sessionId);
    this.revives.delete(sessionId);
    this.hitUntil.delete(sessionId);
  }

  // The player cannot act (down, watching, between rounds): whatever they were
  // doing is dropped.
  cancel(sessionId: string): void {
    this.revives.delete(sessionId);
  }

  // What one player asked for this frame. Nothing when their input is late.
  act(sessionId: string, input: AppliedInput | undefined): void {
    const player = this.playerOf(sessionId);
    if (player?.status !== 'active') {
      this.cancel(sessionId);
      return;
    }
    const body = this.sim.bodyOf(sessionId);
    if (!input || !body) {
      return;
    }

    if (input.attack) {
      // an attack, even one still cooling down, breaks off a revive
      this.cancel(sessionId);
      if ((this.cooldown.get(sessionId) ?? 0) === 0) {
        if (player.role === 'owner') {
          this.shoot(player, body.x, body.y, body.facing);
        } else {
          this.melee(player, body.x, body.y, body.facing);
        }
      }
      return;
    }

    if (input.interact) {
      this.reviveStep(player);
    } else {
      this.cancel(sessionId);
    }
  }

  // The rest of the frame: cooldowns, bullets and revives that are still valid.
  frame(): void {
    for (const [id, left] of this.cooldown) {
      if (left <= 1) {
        this.cooldown.delete(id);
      } else {
        this.cooldown.set(id, left - 1);
      }
    }

    this.advanceBullets();

    // a revive only goes on while both are still what it needs them to be
    for (const [reviverId, revive] of [...this.revives]) {
      const reviver = this.playerOf(reviverId);
      const target = this.playerOf(revive.target);
      if (
        reviver?.status !== 'active' ||
        target?.status !== 'incapacitated' ||
        !this.match.playing
      ) {
        this.revives.delete(reviverId);
      }
    }

    this.frameNo++;
  }

  // ---- attacks -------------------------------------------------------------

  private shoot(player: MatchPlayer, x: number, y: number, dir: 1 | -1): void {
    const mask = this.map.playerMask;
    const edge = dir === 1 ? mask.right + 1 : mask.left;
    this.live.push({
      id: this.nextBullet++,
      ownerId: player.sessionId,
      team: player.team,
      x: Math.round(x) + edge + dir * MUZZLE_AHEAD,
      y: Math.round(y) + MUZZLE_DROP,
      dir,
    });
    this.cooldown.set(player.sessionId, PISTOL_COOLDOWN);
  }

  private melee(player: MatchPlayer, x: number, y: number, dir: 1 | -1): void {
    const box = this.boxAt(x, y);
    // from the attacker's own box out to the reach in front: an enemy standing
    // right up against them is hit too
    const rect: Rect = {
      left: dir === 1 ? box.left : box.left - MELEE_REACH,
      right: dir === 1 ? box.right + MELEE_REACH : box.right,
      top: box.top,
      bottom: box.bottom,
    };

    for (const enemy of this.enemiesOf(player.team)) {
      const enemyBody = this.sim.bodyOf(enemy.sessionId);
      if (enemyBody && overlaps(rect, this.boxAt(enemyBody.x, enemyBody.y))) {
        this.match.damage(enemy.sessionId, MELEE_DAMAGE);
      }
    }

    this.cooldown.set(player.sessionId, MELEE_COOLDOWN);
    this.hitUntil.set(player.sessionId, this.frameNo + HIT_ANIM_FRAMES);
    for (const listener of this.meleeListeners) {
      listener({ attackerId: player.sessionId, role: player.role, rect });
    }
  }

  // ---- bullets -------------------------------------------------------------

  private advanceBullets(): void {
    const solids = this.map.colliders.filter((c) => c.kind === 'solid');
    const survivors: Bullet[] = [];

    for (const bullet of this.live) {
      bullet.x += bullet.dir * BULLET_SPEED;
      const box: Rect = {
        left: bullet.x - BULLET_HALF,
        right: bullet.x + BULLET_HALF,
        top: bullet.y - BULLET_HALF,
        bottom: bullet.y + BULLET_HALF,
      };

      const outside = bullet.x < 0 || bullet.x > this.map.width;
      if (outside || solids.some((c) => overlaps(box, c.rect))) {
        continue; // stopped by a wall or gone from the room
      }

      // it hits the first enemy still on their feet; teammates and the fallen
      // let it through (AC-054)
      const victim = this.enemiesOf(bullet.team).find((enemy) => {
        const body = this.sim.bodyOf(enemy.sessionId);
        return body && overlaps(box, this.boxAt(body.x, body.y));
      });
      if (victim) {
        this.match.damage(victim.sessionId, SHOT_DAMAGE);
        continue;
      }
      survivors.push(bullet);
    }
    this.live = survivors;
  }

  // ---- reviving ------------------------------------------------------------

  private reviveStep(reviver: MatchPlayer): void {
    const body = this.sim.bodyOf(reviver.sessionId);
    if (!body || !this.match.playing || this.match.inSuddenDeath) {
      this.cancel(reviver.sessionId);
      return;
    }

    const mine = this.boxAt(body.x, body.y);
    const reach: Rect = {
      left: mine.left - REVIVE_REACH_X,
      right: mine.right + REVIVE_REACH_X,
      top: mine.top - REVIVE_REACH_Y,
      bottom: mine.bottom + REVIVE_REACH_Y,
    };
    const target = this.match.roster().find((p) => {
      if (p.team !== reviver.team || p.status !== 'incapacitated') {
        return false;
      }
      const other = this.sim.bodyOf(p.sessionId);
      return !!other && overlaps(reach, this.boxAt(other.x, other.y));
    });
    if (!target) {
      this.cancel(reviver.sessionId);
      // nobody to get up: the key may do something else (repairing a machine)
      for (const listener of this.interactListeners) {
        listener({ playerId: reviver.sessionId, role: reviver.role, reach });
      }
      return;
    }

    const current = this.revives.get(reviver.sessionId);
    const frames =
      current?.target === target.sessionId ? current.frames + 1 : 1;
    if (frames >= REVIVE_FRAMES) {
      this.match.revive(target.sessionId);
      // anyone else working on the same player is done too
      for (const [id, revive] of [...this.revives]) {
        if (revive.target === target.sessionId) {
          this.revives.delete(id);
        }
      }
      this.revives.delete(reviver.sessionId);
      return;
    }
    this.revives.set(reviver.sessionId, { target: target.sessionId, frames });
  }

  // ---- helpers -------------------------------------------------------------

  private playerOf(sessionId: string): MatchPlayer | undefined {
    return this.match.roster().find((p) => p.sessionId === sessionId);
  }

  // enemies who can still be hit: on their feet
  private enemiesOf(team: Team): MatchPlayer[] {
    return this.match
      .roster()
      .filter((p) => p.team !== team && p.status === 'active');
  }

  // the player mask at a position, rounded like the physics does
  private boxAt(x: number, y: number): Rect {
    const mask = this.map.playerMask;
    const rx = Math.round(x);
    const ry = Math.round(y);
    return {
      left: rx + mask.left,
      right: rx + mask.right,
      top: ry + mask.top,
      bottom: ry + mask.bottom,
    };
  }
}
