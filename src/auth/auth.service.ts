import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RegisterDTO } from './dtos/register.dto';
import { SecurityService } from 'src/security/security.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { JWTPayloadDTO } from './dtos/jwt.dto';
import jwt from 'jsonwebtoken';

@Injectable()
export class AuthService {
    constructor(private readonly prisma: PrismaService, private readonly security: SecurityService) {}

    public async register(body: RegisterDTO) {
        const [salt, hash] = this.security.hashPassword(body.password).split(":");

        try {
            const user = await this.prisma.user.create({
                data: {
                    username: this.security.encrypt(body.username),
                    password: hash,
                    salt
                }
            })
    
            const token = this.generateJWT(user as JWTPayloadDTO);
            
            return token;
        } catch (error) {
            console.error(error);
            throw new UnauthorizedException("This username is already in use")
        }

    }

    private generateJWT(payload: JWTPayloadDTO, expiresIn: number = 1440): string {
        const SECRET_KEY = process.env.SECRET_KEY;

        if (!SECRET_KEY) {
            throw new Error('Missing Secret Key in .env');
        }

        const token = jwt.sign(payload, SECRET_KEY, {
            expiresIn, // tempo de expiração do token
        });

        return token;
    }
}
