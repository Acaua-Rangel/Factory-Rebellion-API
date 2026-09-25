import { NestFactory } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from './app.module';
import { corsOptionsFromEnv } from './cors-options';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors(corsOptionsFromEnv(process.env));
  app.useGlobalPipes(new ZodValidationPipe());
  // lets docker stop the container cleanly (SIGTERM closes sockets, timers)
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
