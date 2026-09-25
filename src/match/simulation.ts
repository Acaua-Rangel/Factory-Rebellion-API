import { Animation, Body, Input, Physics } from './physics';
import { Point } from './match.types';

// How many frames of input the server keeps waiting for a player (0.5 s), and
// how many it reads from a single message. Together with "one input per frame"
// this stops a client from banking extra speed by sending inputs early.
export const MAX_QUEUE = 30;
export const MAX_BATCH = 30;

interface QueuedInput extends Input {
  seq: number;
}

interface PlayerSim {
  body: Body;
  queue: QueuedInput[];
  // highest input number accepted / last input number applied
  lastQueued: number;
  ack: number;
}

const isKey = (value: unknown): boolean => value === true || value === 1;

// The physical side of a match: one body and one input queue per player. The
// client sends inputs (key states with a number); the server moves the bodies,
// one input per player per 1/60 s frame (AC-061), and reports the number of the
// last input it applied so the client can correct its prediction (AC-060).
export class Simulation {
  private readonly players = new Map<string, PlayerSim>();
  private frames = 0;

  constructor(private readonly physics: Physics) {}

  get frame(): number {
    return this.frames;
  }

  advance(): void {
    this.frames++;
  }

  // A fresh body at `at` (round start, or a newcomer). Input numbers keep
  // counting, so the client does not have to restart its own.
  add(sessionId: string, at: Point): void {
    const previous = this.players.get(sessionId);
    this.players.set(sessionId, {
      body: this.physics.createBody(at),
      queue: [],
      lastQueued: previous?.lastQueued ?? 0,
      ack: previous?.ack ?? 0,
    });
  }

  remove(sessionId: string): void {
    this.players.delete(sessionId);
  }

  animationOf(sessionId: string): Animation {
    const body = this.players.get(sessionId)?.body;
    return body ? this.physics.animationOf(body) : 'idle';
  }

  bodyOf(sessionId: string): Body | undefined {
    return this.players.get(sessionId)?.body;
  }

  ackOf(sessionId: string): number {
    return this.players.get(sessionId)?.ack ?? 0;
  }

  // A client that reloaded starts counting its inputs from 1 again.
  resync(sessionId: string): void {
    const player = this.players.get(sessionId);
    if (player) {
      player.queue = [];
      player.lastQueued = 0;
      player.ack = 0;
    }
  }

  // Reads {inputs: [{seq, l, r, j, f}, …]} from a client. Only the number and
  // the four keys are ever taken; anything else, including claimed positions,
  // is ignored (AC-062). Returns how many inputs were accepted.
  enqueue(sessionId: string, raw: unknown): number {
    const player = this.players.get(sessionId);
    const list = (raw as { inputs?: unknown } | null | undefined)?.inputs;
    if (!player || !Array.isArray(list)) {
      return 0;
    }

    let accepted = 0;
    for (const entry of list.slice(0, MAX_BATCH)) {
      if (player.queue.length >= MAX_QUEUE) {
        break;
      }
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const e = entry as Record<string, unknown>;
      // numbers must keep going up: a repeated or old input is a replay
      if (!Number.isInteger(e.seq) || (e.seq as number) <= player.lastQueued) {
        continue;
      }
      player.lastQueued = e.seq as number;
      player.queue.push({
        seq: e.seq as number,
        left: isKey(e.l),
        right: isKey(e.r),
        jump: isKey(e.j),
        down: isKey(e.f),
      });
      accepted++;
    }
    return accepted;
  }

  // One frame of one player. `canMove` false (down, waiting, between rounds):
  // their inputs are thrown away but acknowledged, and the body stays put.
  step(sessionId: string, canMove: boolean): void {
    const player = this.players.get(sessionId);
    if (!player) {
      return;
    }

    if (!canMove) {
      if (player.queue.length > 0) {
        player.ack = player.queue[player.queue.length - 1].seq;
        player.queue = [];
      }
      return;
    }

    // No input for this frame (it is late): the player waits. Nothing moves and
    // nothing is repeated, so the body is always exactly the result of the inputs
    // applied so far, in order. That is what lets the client compare its own
    // prediction at input N with the server's position at input N (AC-060), and
    // it means a laggy or bursty connection can delay a player but never make
    // them faster.
    const next = player.queue.shift();
    if (!next) {
      return;
    }
    player.ack = next.seq;
    const input: Input = next;
    this.physics.step(player.body, input);
  }
}
