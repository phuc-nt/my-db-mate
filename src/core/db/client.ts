/** App-DB (Postgres) connection pool + Drizzle instance. */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as baseSchema from '@/core/db/schema';
import * as contextSchema from '@/core/db/context-schema';
import * as intelligenceSchema from '@/core/db/intelligence-schema';
import * as ecosystemSchema from '@/core/db/ecosystem-schema';
import * as dashboardSchema from '@/core/db/dashboard-schema';
import * as reportSchema from '@/core/db/report-schema';
import * as notebookSchema from '@/core/db/notebook-schema';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing in env');

const schema = { ...baseSchema, ...contextSchema, ...intelligenceSchema, ...ecosystemSchema, ...dashboardSchema, ...reportSchema, ...notebookSchema };
export const appPool = new Pool({ connectionString: url });
export const db = drizzle(appPool, { schema });
export { schema };
