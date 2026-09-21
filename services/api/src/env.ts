import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_ANON_KEY: z.string().min(20),

  CORS_ORIGINS: z.string().default('http://localhost:8081'),
  EXPO_PUSH_URL: z.string().url().default('https://exp.host/--/api/v2/push/send'),
  AUDIO_SIGNED_URL_TTL: z.coerce.number().int().positive().max(3600).default(120),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail loudly at boot rather than 500-ing on the first emergency.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\nCopy services/api/.env.example to services/api/.env and fill it in.');
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === 'production',
};
