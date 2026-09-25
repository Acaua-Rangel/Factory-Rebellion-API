import { Team } from './match.types';

// `members` = players of each team still in the room (a player who left or
// stayed disconnected past the 60 s grace period is not counted). When a whole
// team is gone the other one wins by walkover (AC-046).
export function walkoverWinner(members: Record<Team, number>): Team | null {
  if (members.workers === 0 && members.capatazes > 0) {
    return 'capatazes';
  }
  if (members.capatazes === 0 && members.workers > 0) {
    return 'workers';
  }
  return null;
}
