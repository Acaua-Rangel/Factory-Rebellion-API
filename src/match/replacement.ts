import { Look, MatchPlayer, Role, Team } from './match.types';

// The team, role and look a player leaves behind when they quit: whoever
// takes the seat inherits exactly that (AC-072).
export interface Seat {
  team: Team;
  role: Role;
  look: Look | null;
}

export const seatOf = (player: MatchPlayer): Seat => ({
  team: player.team,
  role: player.role,
  look: player.look,
});

// The seat that has been open the longest goes first.
export function takeSeat(open: Seat[]): Seat | undefined {
  return open.shift();
}
