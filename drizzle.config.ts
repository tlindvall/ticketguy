import { defineConfig } from 'drizzle-kit';

// Schema → SQL migration generation only. Migrations are applied by scripts/migrate.ts
// (never `drizzle-kit push` against production).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://unused' },
  strict: true,
  verbose: true,
});
