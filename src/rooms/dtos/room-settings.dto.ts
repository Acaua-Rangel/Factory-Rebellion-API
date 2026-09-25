import { z } from 'zod';

const size = z.union([z.literal(4), z.literal(8)]);
const visibility = z.enum(['public', 'private']);
const rounds = z.union([z.literal(4), z.literal(5), z.literal(6)]);

// Creating a room: size and visibility are required, rounds default to 4 (AC-016).
export const CreateRoomSchema = z.object({
  size,
  visibility,
  rounds: rounds.default(4),
});

// Changing settings in the lobby: any subset of the three (AC-017).
export const UpdateRoomSettingsSchema = z.object({
  size: size.optional(),
  visibility: visibility.optional(),
  rounds: rounds.optional(),
});
