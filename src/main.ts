import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ZodValidationPipe } from 'nestjs-zod';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Habilitar CORS
  app.enableCors({
    // origin: 'http://localhost:4200', // Permite requisições SOMENTE desta origem
    // origin: true, // Reflete a origem da requisição (útil se você tiver múltiplos front-ends dinamicamente)
    // origin: ['http://localhost:4200', 'https://meuoutrofrontend.com'], // Para múltiplas origens específicas
    origin: '*', // PERMITE QUALQUER ORIGEM - CUIDADO EM PRODUÇÃO! Use apenas para desenvolvimento se necessário.
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS', // Métodos HTTP permitidos
    credentials: true, // Permite o envio de cookies e cabeçalhos de autorização (se necessário)
    allowedHeaders: 'Content-Type, Accept, Authorization', // Cabeçalhos permitidos na requisição
    // exposedHeaders: ['custom-header1', 'custom-header2'], // Cabeçalhos que o cliente pode acessar na resposta
  });

  app.useGlobalPipes(new ZodValidationPipe());

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
