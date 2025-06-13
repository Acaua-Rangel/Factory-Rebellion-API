import * as crypto from 'crypto';
import * as aesjs from 'aes-js';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SecurityService {

    // Função para criptografar
    encrypt(text: string): string {
        const textBytes = aesjs.utils.utf8.toBytes(text);
        const paddedBytes = aesjs.padding.pkcs7.pad(textBytes);

        if (!process.env.SECRET_KEY || !process.env.IV) {
            throw new Error('Missing Secret Key or IV in .env')
        }

        const secretKey = aesjs.utils.hex.toBytes(process.env.SECRET_KEY);
        const iv = aesjs.utils.hex.toBytes(process.env.IV);
    
        const aesCbc = new aesjs.ModeOfOperation.cbc(secretKey, iv);
        const encryptedBytes = aesCbc.encrypt(paddedBytes);
    
        return aesjs.utils.hex.fromBytes(encryptedBytes);
    }
    // Função para descriptografar
    decrypt(encryptedHex: string): string {
        const encryptedBytes = aesjs.utils.hex.toBytes(encryptedHex);

        if (!process.env.SECRET_KEY || !process.env.IV) {
            throw new Error('Missing Secret Key or IV in .env')
        }

        const secretKey = aesjs.utils.hex.toBytes(process.env.SECRET_KEY);
        const iv = aesjs.utils.hex.toBytes(process.env.IV);
    
        const aesCbc = new aesjs.ModeOfOperation.cbc(secretKey, iv);
        const decryptedBytes = aesCbc.decrypt(encryptedBytes);
    
        return aesjs.utils.utf8.fromBytes(aesjs.padding.pkcs7.strip(decryptedBytes));
    }

    // Função de criação de hash com sal, no formato SALT:HASH
    hashPassword(password: string): string {
        const salt = crypto.randomBytes(16).toString("hex"); // 16 bytes (32 caracteres hex)
        const hash = crypto.createHmac("sha256", salt).update(password).digest("hex");
    
        return `${salt}:${hash}`;
    }

    secHash(key: string): string {
        const SECRET_KEY = process.env.SECRET_KEY;

        if (!SECRET_KEY) {
            throw new Error('Missing Secret Key in .env');
        }

        const hash = crypto.createHmac("sha256", SECRET_KEY).update(key).digest("hex");
    
        return hash;
    }
    
    // Verificação de senha com base em hash com sal
    verifyPassword(password: string, storedHash: string): boolean {
        const [salt, originalHash] = storedHash.split(":");
        const hash = crypto.createHmac("sha256", salt).update(password).digest("hex");
    
        return hash === originalHash;
    }
}
