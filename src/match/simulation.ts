import { Animation, Body, Input, Physics } from './physics';
import { Point } from './match.types';

// How many frames of input the server keeps waiting for a player (0.5 s), and
// how many it reads from a single message. Together with "one input per frame"
// this stops a client from banking extra speed by sending inputs early.
export const MAX_QUEUE = 30;
export const MAX_BATCH = 30;

// What one frame of a player asked for: the four movement keys, the attack
// key (a press, like jump) and the interact key (held: revive, repair).
export interface AppliedInput extends Input {
  seq: number;
  attack: boolean;
  interact: boolean;
}

// move = follow the inputs · fall = ignore them but let gravity act (a downed
// player) · frozen = nothing moves (between rounds, waiting for a round)
export type Motion = 'move' | 'fall' | 'frozen';

const NO_KEYS: Input = { left: false, right: false, jump: false, down: false };

type QueuedInput = AppliedInput;

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
        attack: isKey(e.a),
        interact: isKey(e.e),
      });
      accepted++;
    }
    return accepted;
  }

  // One frame of one player. Returns the input it applied (so combat can act
  // on the attack and interact keys), or undefined when there was none.
  // `true`/`false` mean move/frozen.
  step(sessionId: string, motion: Motion | boolean): AppliedInput | undefined {
    const player = this.players.get(sessionId);
    if (!player) {
      return undefined;
    }
    const mode: Motion =
      motion === true ? 'move' : motion === false ? 'frozen' : motion;

    if (mode !== 'move') {
      // their inputs are thrown away but acknowledged, so the client's
      // prediction does not pile up
      if (player.queue.length > 0) {
        player.ack = player.queue[player.queue.length - 1].seq;
        player.queue = [];
      }
      if (mode === 'fall') {
        this.physics.step(player.body, NO_KEYS);
      }
      return undefined;
    }

    // No input for this frame (it is late): the player waits. Nothing moves and
    // nothing is repeated, so the body is always exactly the result of the inputs
    // applied so far, in order. That is what lets the client compare its own
    // prediction at input N with the server's position at input N (AC-060), and
    // it means a laggy or bursty connection can delay a player but never make
    // them faster.
    const next = player.queue.shift();
    if (!next) {
      return undefined;
    }
    player.ack = next.seq;
    this.physics.step(player.body, next);
    return next;
  }
}
