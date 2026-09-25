import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module';

describe('Legacy password login removal', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.SECRET_KEY = process.env.SECRET_KEY ?? '00'.repeat(16);
    process.env.IV = process.env.IV ?? '00'.repeat(16);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-008: old register and login addresses no longer exist @spec:AC-008', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ username: 'ZEZINHO', password: 'secret1' })
      .expect(404);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'ZEZINHO', password: 'secret1' })
      .expect(404);
  });
});
