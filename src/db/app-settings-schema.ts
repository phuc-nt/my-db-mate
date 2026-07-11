import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Global key-value settings (LLM provider config, …). Secrets in `value` are
 *  stored AES-256-GCM-encrypted by the settings service — never plaintext. */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
