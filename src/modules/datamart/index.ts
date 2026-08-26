/**
 * Datamart advisor: public surface.
 *
 * The advisor only PROPOSES marts — adoption writes governed virtual views
 * through core's boundary layer. Scope enforcement and view expansion are
 * deliberately not part of this module: a deployment that drops the advisor still
 * enforces the boundary, which is the whole point of that split.
 */
export {
  collectAdvisorInputs,
  proposeDatamarts,
  validateProposal,
  ValidatedProposalSchema,
  adoptAsVirtualViews,
  exportProposal,
} from './datamart-advisor-service';
