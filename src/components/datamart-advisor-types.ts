/** Shapes the datamart advisor API returns, shared by the panel and the mart card.
 *  Kept apart from the service so a client component never pulls the server
 *  module (and its database and provider imports) into the browser bundle. */
export interface ValidatedSummaryTable {
  name: string;
  description: string;
  sql: string;
  valid: boolean;
  reason?: string;
  estimatedBytes?: number;
  columns?: { name: string; type: string }[];
}

export interface ValidatedMart {
  name: string;
  purpose: string;
  grain: string;
  sourceTables: string[];
  assumptions: string[];
  summaryTables: ValidatedSummaryTable[];
}

export interface ValidatedProposal {
  marts: ValidatedMart[];
  notes?: string;
  totalEstimatedBytes: number;
}

export interface ProposeResponse {
  proposal: ValidatedProposal;
  degraded: boolean;
  degradedReasons: string[];
  tablesSurveyed: number;
  runsRead: number;
  error?: string;
}

export interface AdoptionResult {
  adopted: { martName: string; viewName: string; viewId: string }[];
  failed: { martName: string; viewName: string; reason: string }[];
}
