import { corsOptionsFromEnv } from './cors-options';

describe('corsOptionsFromEnv', () => {
  it('allows no browser origin when ALLOWED_ORIGINS is not set', () => {
    expect(corsOptionsFromEnv({}).origin).toBe(false);
    expect(corsOptionsFromEnv({ ALLOWED_ORIGINS: '  ' }).origin).toBe(false);
  });

  it('allows only the listed origins', () => {
    const options = corsOptionsFromEnv({
      ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    });

    expect(options.origin).toEqual(['https://a.example', 'https://b.example']);
  });

  it('never reflects or wildcards an origin', () => {
    const { origin } = corsOptionsFromEnv({ ALLOWED_ORIGINS: '*' });

    expect(origin).not.toBe(true);
    expect(origin).not.toBe('*');
  });
});
