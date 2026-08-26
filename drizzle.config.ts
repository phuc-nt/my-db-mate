import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  schema: ['./src/core/db/schema.ts', './src/core/db/context-schema.ts', './src/core/db/intelligence-schema.ts', './src/core/db/ecosystem-schema.ts', './src/core/db/dashboard-schema.ts', './src/core/db/report-schema.ts', './src/core/db/notebook-schema.ts', './src/core/db/app-settings-schema.ts', './src/core/db/feedback-schema.ts', './src/core/db/monitor-schema.ts', './src/core/db/metric-schema.ts', './src/core/db/anomaly-schema.ts', './src/core/db/action-trigger-schema.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
