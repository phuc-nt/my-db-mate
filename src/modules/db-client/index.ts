/**
 * DB client: public surface.
 *
 * The workload advisor is the only part with consumers outside the module today;
 * browse/ERD/bookmark rendering lives in the app layer and reads core directly.
 */
export { adviseWorkload } from './workload-advisor/advisor-rules';
export { collectWorkloadStats } from './workload-advisor/workload-stats-collector';
