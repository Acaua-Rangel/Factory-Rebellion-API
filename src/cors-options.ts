import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

// The GameMaker client is a desktop app, not a browser, so CORS is closed by
// default. ALLOWED_ORIGINS="https://a.example,https://b.example" opens it for
// specific web front ends only — never a wildcard.
export function corsOptionsFromEnv(
  env: Record<string, string | undefined>,
): CorsOptions {
  const origins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== '*');

  return {
    origin: origins.length > 0 ? origins : false,
    methods: 'GET,HEAD,POST,OPTIONS',
    allowedHeaders: 'Content-Type, Accept',
  };
}
