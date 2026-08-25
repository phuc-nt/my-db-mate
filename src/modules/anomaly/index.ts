/**
 * Anomaly + data quality: public surface.
 *
 * Its own module rather than part of db-client because both `automations` (drift
 * monitors) and `chat-agent` (the in-loop anomaly tool) consume it; folding it
 * into db-client would make the agent depend on the DB-client UI module.
 */
export { detectAnomalies } from './anomaly-service';
export type { AnomalyReport } from './anomaly-service';
export { profileConnection, getDataHealth } from './data-quality-service';
