import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const RegisterSchema = z.object({
    username: z.string().min(4),
    password: z.string().min(6)
})
export class RegisterDTO extends createZodDto(RegisterSchema) {}