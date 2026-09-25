import { SessionService } from './session.service';

describe('Session expiry and resume', () => {
  let sessions: SessionService;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    sessions = new SessionService();
    sessions.clock = () => now;
  });

  it('AC-006: reconnecting within 60 seconds keeps my identity @spec:AC-006', () => {
    const session = sessions.create('ZE');
    sessions.markDisconnected(session.token);

    now += 59_000;
    const resumed = sessions.resume(session.token);

    expect(resumed.status).toBe('resumed');
    if (resumed.status === 'resumed') {
      expect(resumed.session.sessionId).toBe(session.sessionId);
      expect(resumed.session.nickname).toBe('ZE');
    }
  });

  it('AC-007: an expired session must enter again @spec:AC-007', () => {
    const session = sessions.create('ZE');
    sessions.markDisconnected(session.token);

    now += 61_000;
    const resumed = sessions.resume(session.token);

    expect(resumed).toEqual({ status: 'expired' });
    expect(sessions.findByToken(session.token)).toBeUndefined();
  });

  it('AC-007: an unknown token is also refused @spec:AC-007', () => {
    expect(sessions.resume('not-a-real-token')).toEqual({ status: 'expired' });
  });

  it('AC-006: a session that never dropped can be resumed at any time @spec:AC-006', () => {
    const session = sessions.create('ZE');
    now += 10 * 60_000;
    expect(sessions.resume(session.token).status).toBe('resumed');
  });

  it('AC-006: resuming clears the disconnect timer @spec:AC-006', () => {
    const session = sessions.create('ZE');
    sessions.markDisconnected(session.token);
    now += 30_000;
    sessions.resume(session.token);
    now += 120_000;
    expect(sessions.resume(session.token).status).toBe('resumed');
  });

  it('AC-007: purgeExpired removes sessions past the grace period @spec:AC-007', () => {
    const gone = sessions.create('GONE');
    const stays = sessions.create('STAYS');
    sessions.markDisconnected(gone.token);
    now += 61_000;

    expect(sessions.purgeExpired()).toEqual([gone.sessionId]);
    expect(sessions.findByToken(gone.token)).toBeUndefined();
    expect(sessions.findByToken(stays.token)).toBeDefined();
  });
});
