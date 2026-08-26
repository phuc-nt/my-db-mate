/**
 * Eval harness: public surface.
 *
 * Runs saved questions through the real agent loop and scores the results. The
 * benchmark module (bench) is a sibling that does the same for a public dataset;
 * both consume `chat-agent` through its barrel rather than reimplementing a loop.
 */
export { addEvalQuery, listEvalQueries, listEvalRuns, runEval } from './eval-service';
