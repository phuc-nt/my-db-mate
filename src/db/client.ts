/** App-DB (Postgres) connection pool + Drizzle instance. */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as baseSchema from './schema';
import * as contextSchema from './context-schema';
import * as intelligenceSchema from './intelligence-schema';
import * as ecosystemSchema from './ecosystem-schema';
import * as dashboardSchema from './dashboard-schema';
import * as reportSchema from './report-schema';
import * as notebookSchema from './notebook-schema';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing in env');

const schema = { ...baseSchema, ...contextSchema, ...intelligenceSchema, ...ecosystemSchema, ...dashboardSchema, ...reportSchema, ...notebookSchema };
export const appPool = new Pool({ connectionString: url });
export const db = drizzle(appPool, { schema });
export { schema };
