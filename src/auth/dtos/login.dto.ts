import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const LoginSchema = z.object({
    username: z.string().min(4),
    password: z.string().min(6)
})
export class LoginDTO extends createZodDto(LoginSchema) {}