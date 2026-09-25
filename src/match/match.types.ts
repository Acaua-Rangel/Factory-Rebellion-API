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
