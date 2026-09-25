import { Team } from './match.types';

// `standing` = players of the team not yet eliminated. Eliminated players stay
// out for the rest of the match (AC-043). Returns the winning team, 'tie' when
// both teams are wiped in the same tick (AC-066: the round is replayed), or
// null while both teams still have someone standing.
export function suddenDeathOutcome(
  standing: Record<Team, number>,
): Team | 'tie' | null {
  if (standing.workers === 0 && standing.capatazes === 0) {
    return 'tie';
  }
  if (standing.workers === 0) {
    return 'capatazes';
  }
  if (standing.capatazes === 0) {
    return 'workers';
  }
  return null;
}
