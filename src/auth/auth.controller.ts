import { Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import { RegisterDTO } from './dtos/register.dto';
import { AuthService } from './auth.service';
import { Response } from 'express';
import { LoginDTO } from './dtos/login.dto';

@Controller('auth')
export class AuthController {

    constructor(private readonly service: AuthService) {}

    @Post('login')
    async login(@Body() body: LoginDTO, @Res() res: Response) {
        const token = await this.service.login(body);

        res.status(HttpStatus.CREATED).json({ message: "User Logged", token })
    }

    @Post('register')
    async register(@Body() body: RegisterDTO, @Res() res: Response) {
        const token = await this.service.register(body);

        res.status(HttpStatus.CREATED).json({ message: "User Created", token })
    }
}
