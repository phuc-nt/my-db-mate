import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  schema: ['./src/db/schema.ts', './src/db/context-schema.ts', './src/db/intelligence-schema.ts', './src/db/ecosystem-schema.ts', './src/db/dashboard-schema.ts', './src/db/report-schema.ts', './src/db/notebook-schema.ts', './src/db/app-settings-schema.ts', './src/db/feedback-schema.ts', './src/db/monitor-schema.ts', './src/db/metric-schema.ts', './src/db/anomaly-schema.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
