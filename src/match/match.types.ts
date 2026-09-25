export type Team = 'workers' | 'capatazes';

// Operário, Dono (Owner) and Policial (Policeman)
export type Role = 'worker' | 'owner' | 'policeman';

// Operário 1 and Operário 2 are only different looks (ASM-013)
export type Look = 'op1' | 'op2';

export interface DrawnPlayer {
  sessionId: string;
  nickname: string;
  team: Team;
  role: Role;
  // only workers have a look
  look: Look | null;
}

export const otherTeam = (team: Team): Team =>
  team === 'workers' ? 'capatazes' : 'workers';

export interface Point {
  x: number;
  y: number;
}

// active = playing · incapacitated = down until the next round · eliminated =
// out for the rest of the match (sudden death) · spectating = a newcomer who
// enters at the next round start
export type PlayerStatus =
  | 'active'
  | 'incapacitated'
  | 'eliminated'
  | 'spectating';

// Public information about a player in a match — never a session token (P-005).
export interface MatchPlayer extends DrawnPlayer {
  status: PlayerStatus;
  // half-hearts: 6 = three full hearts (ASM-018)
  life: number;
  position: Point;
}
