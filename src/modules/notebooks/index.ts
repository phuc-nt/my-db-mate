/**
 * Notebooks: public surface.
 *
 * Exactly what the API routes outside this module call today — `extractRefreshPairs`
 * stays internal because only `notebook-service` uses it, and exporting it would
 * invite callers to re-implement refresh outside the service that owns the rules.
 *
 * The service's own types are not re-exported. Callers get them by inference from
 * the functions above, so naming them here would widen the surface without adding
 * a caller — and an exported type is a promise about a shape, which is the part
 * that is expensive to take back.
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
