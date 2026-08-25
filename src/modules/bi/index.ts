/**
 * BI (dashboards + reports): public surface.
 *
 * Exactly the symbols consumed outside this module today — the dashboard/report
 * API routes, and `automations` (which refreshes dashboards and generates
 * scheduled reports). Everything else, including the widget-generation internals
 * and the LLM prompt builders, stays private: a scheduled refresh should call
 * `runWidget`, not reassemble a widget from parts.
 *
 * Chart mapping is NOT here — `chart-spec-service`/`chart-data` are core, because
 * chat result blocks render charts too and must not depend on BI for it.
 */
export {
  createDashboard,
  listDashboards,
  getDashboard,
  renameDashboard,
  deleteDashboard,
  pinWidget,
  deleteWidget,
  updateWidgetLayout,
  runWidget,
  setShare,
  getSharedDashboard,
} from './dashboard-service';
export type { CrossFilter } from './dashboard-service';

export { generateDashboardProposal, acceptDashboardProposal } from './dashboard-generation-service';
export { proposeWidgetEdit, applyWidgetEdit } from './widget-edit-service';

export {
  createReport,
  listReports,
  deleteReport,
  generateReport,
  getReportLatest,
  setReportShare,
  getSharedReport,
} from './report-service';
