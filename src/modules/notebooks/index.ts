/**
 * Notebooks: public surface.
 *
 * Exactly what the API routes outside this module call today — `extractRefreshPairs`
 * stays internal because only `notebook-service` uses it, and exporting it would
 * invite callers to re-implement refresh outside the service that owns the rules.
 */
export {
  createNotebookFromSession,
  listNotebooks,
  getNotebook,
  deleteNotebook,
  setNotebookShare,
  getSharedNotebook,
  rerunNotebook,
} from './notebook-service';
export type { NotebookSnapshot, RefreshSummary } from './notebook-service';
