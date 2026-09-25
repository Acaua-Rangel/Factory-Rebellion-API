import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ZodValidationPipe } from 'nestjs-zod';
import { SessionModule } from './session.module';
import { SessionService } from './session.service';

describe('Guest session', () => {
  let app: INestApplication;
  let sessions: SessionService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    sessions = moduleRef.get(SessionService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('AC-001: a nickname alone opens a session @spec:AC-001', async () => {
    const res = await request(app.getHttpServer())
      .post('/sessions')
      .send({ nickname: 'ZE' })
      .expect(201);

    expect(res.body.nickname).toBe('ZE');
    expect(typeof res.body.sessionId).toBe('string');
    expect(res.body.sessionId.length).toBeGreaterThan(0);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);
  });

  it('AC-002: two players can use the same nickname @spec:AC-002', async () => {
    const first = await request(app.getHttpServer())
      .post('/sessions')
      .send({ nickname: 'ZE' })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/sessions')
      .send({ nickname: 'ZE' })
      .expect(201);

    expect(second.body.sessionId).not.toBe(first.body.sessionId);
    expect(second.body.token).not.toBe(first.body.token);
    expect(sessions.findByToken(first.body.token)).toBeDefined();
    expect(sessions.findByToken(second.body.token)).toBeDefined();
    expect(sessions.count()).toBe(2);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['too long', 'ABCDEFGHIJKLM'],
    ['spaces inside', 'JOAO SILVA'],
    ['accented', 'JOÃO'],
    ['symbols', 'ZE!'],
  ])(
    'AC-003: an invalid nickname (%s) is refused @spec:AC-003',
    async (_label, nickname) => {
      await request(app.getHttpServer())
        .post('/sessions')
        .send({ nickname })
        .expect(400);
      expect(sessions.count()).toBe(0);
    },
  );

  it('AC-003: a missing nickname is refused @spec:AC-003', async () => {
    await request(app.getHttpServer()).post('/sessions').send({}).expect(400);
    expect(sessions.count()).toBe(0);
  });

  it('AC-001: nicknames are trimmed and stored in uppercase @spec:AC-001', async () => {
    const res = await request(app.getHttpServer())
      .post('/sessions')
      .send({ nickname: '  ze_1  ' })
      .expect(201);
    expect(res.body.nickname).toBe('ZE_1');
  });

  it('AC-004: session tokens are unguessable and distinct @spec:AC-004', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const { token } = sessions.create('ZE');
      expect(token).toMatch(/^[0-9a-f]{32,}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(1000);
  });

  it('AC-005: other players never see my token @spec:AC-005 @principle:P-005', () => {
    const session = sessions.create('ZE');
    const view = sessions.toPublic(session);

    expect(view).toEqual({ sessionId: session.sessionId, nickname: 'ZE' });
    expect(JSON.stringify(view)).not.toContain(session.token);
  });
});
