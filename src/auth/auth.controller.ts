import { Body, Controller, Post } from '@nestjs/common';
import { RegisterDTO } from './dtos/register.dto';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {

    constructor(private readonly service: AuthService) {}

    @Post('register')
    async register(@Body() body: RegisterDTO) {
        const token = this.service.register(body);
    }
}
