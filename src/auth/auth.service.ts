import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RegisterDTO } from './dtos/register.dto';
import { SecurityService } from 'src/security/security.service';
import { JWTPayloadDTO } from './dtos/jwt.dto';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from 'src/prisma/prisma.service';
import { LoginDTO } from './dtos/login.dto';

@Injectable()
export class AuthService {
    constructor(private readonly prisma: PrismaService, private readonly security: SecurityService) {}

    public async register(body: RegisterDTO): Promise<string> {
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
        } catch {
            throw new UnauthorizedException("This username is already in use");
        }

    }

    public async login(body: LoginDTO): Promise<string> {
        const user = await this.prisma.user.findUnique({
            where: {
                username: this.security.encrypt(body.username),
                deletedAt: null
            }
        })

        if (!user) {
            throw new UnauthorizedException("Can't find this user");
        }

        const { password, salt } = user;

        const isAuthenticated = this.security.verifyPassword(password, salt);

        if (isAuthenticated) {
            throw new UnauthorizedException("Invalid password");
        }

        const token = this.generateJWT(user as JWTPayloadDTO);

        return token;
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
