import { GameMap, Rect } from './map';
import { Match } from './match-state';
import { Role } from './match.types';

export const MACHINE_HP = 100;
export const MELEE_MACHINE_DAMAGE = 10; // an Operário's hit (ASM-016)
export const REPAIR_PER_SECOND = 5; // the Owner holding the key (ASM-025)

// Integrity is kept in sixtieths of a point so that 5 per second (1/12 of a
// point per frame) adds up exactly: no floating point drift, and a repaired
// machine really reaches 100.
const UNIT = 60;
const FULL = MACHINE_HP * UNIT;
const HIT = MELEE_MACHINE_DAMAGE * UNIT;
const REPAIR_PER_FRAME = REPAIR_PER_SECOND; // (5 * 60 units per second) / 60 frames

const overlaps = (a: Rect, b: Rect) =>
  a.left <= b.right &&
  a.right >= b.left &&
  a.top <= b.bottom &&
  a.bottom >= b.top;

const center = (r: Rect) => ({
  x: (r.left + r.right) / 2,
  y: (r.top + r.bottom) / 2,
});

// The machines of one match: how worn each is, who wears it down (the
// Operários' hits) and who mends it (the Owner). Everything is decided here on
// the server (AC-058); clients only see the result in the snapshots (AC-051).
export class Machines {
  private readonly units = new Map<string, number>();
  private readonly bodies: { id: string; rect: Rect }[];
  private readonly brokenListeners: ((machineId: string) => void)[] = [];

  constructor(
    map: GameMap,
    private readonly match: Match,
  ) {
    this.bodies = map.machines.map((machine) => ({
      id: machine.id,
      rect: map.colliders.find((c) => c.id === machine.collider)!.rect,
    }));
    this.reset();
  }

  onBroken(listener: (machineId: string) => void): void {
    this.brokenListeners.push(listener);
  }

  // A new round: every machine back to intact (AC-051).
  reset(): void {
    for (const { id } of this.bodies) {
      this.units.set(id, FULL);
    }
  }

  integrityOf(machineId: string): number {
    return (this.units.get(machineId) ?? 0) / UNIT;
  }

  list(): { id: string; hp: number; broken: boolean }[] {
    return this.bodies.map(({ id }) => ({
      id,
      hp: this.integrityOf(id),
      broken: (this.units.get(id) ?? 0) <= 0,
    }));
  }

  // A melee attack landed on this box. Only an Operário's hit hurts machines
  // (AC-048), and only where it reaches them (AC-049). Returns the machines
  // this hit broke.
  hit(attackBox: Rect, role: Role): string[] {
    if (role !== 'worker' || !this.match.inRound) {
      return [];
    }
    const justBroken: string[] = [];
    for (const { id, rect } of this.bodies) {
      const units = this.units.get(id) ?? 0;
      if (units <= 0 || !overlaps(attackBox, rect)) {
        continue;
      }
      const left = Math.max(0, units - HIT);
      this.units.set(id, left);
      if (left === 0) {
        justBroken.push(id);
      }
    }
    for (const id of justBroken) {
      this.brokenListeners.forEach((listener) => listener(id));
    }
    return justBroken;
  }

  // One frame of the Owner holding the key next to machines. Only a damaged
  // machine that is not broken is mended, the nearest one if several are in
  // reach (AC-067, AC-068).
  repair(reach: Rect, role: Role): void {
    if (role !== 'owner' || !this.match.inRound) {
      return;
    }
    const from = center(reach);
    let best: { id: string; distance: number } | undefined;
    for (const { id, rect } of this.bodies) {
      const units = this.units.get(id) ?? 0;
      if (units <= 0 || units >= FULL || !overlaps(reach, rect)) {
        continue;
      }
      const to = center(rect);
      const distance = Math.hypot(from.x - to.x, from.y - to.y);
      if (!best || distance < best.distance) {
        best = { id, distance };
      }
    }
    if (best) {
      const units = this.units.get(best.id) ?? 0;
      this.units.set(best.id, Math.min(FULL, units + REPAIR_PER_FRAME));
    }
  }
}
