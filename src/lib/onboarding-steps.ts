/**
 * Which of the three first-run steps are done?
 *
 * Kept as a pure function so the checklist's meaning is testable without a
 * browser: the UI decides only how to draw it. State is DERIVED from things
 * that already exist (an LLM check, the connection list) rather than a
 * persisted "onboarding" flag — a flag would drift from reality the moment a
 * user rotates a key or deletes the demo, and would have to be reset by hand.
 */
import { DEMO_CONNECTION_NAME } from './demo-constants';

export interface OnboardingStep {
  key: 'llm' | 'demo' | 'connect';
  label: string;
  hint: string;
  done: boolean;
}

export interface OnboardingInput {
  /** The `llm` check's status from the setup-health service. */
  llmStatus: string | undefined;
  /** Names of existing connections — the only field this needs. */
  connectionNames: string[];
}

export function deriveOnboardingSteps({ llmStatus, connectionNames }: OnboardingInput): OnboardingStep[] {
  const hasDemo = connectionNames.some((n) => n === DEMO_CONNECTION_NAME);
  // "Real" = anything the user connected themselves. The demo is excluded by
  // name because it is created by us, not by them.
  const hasReal = connectionNames.some((n) => n !== DEMO_CONNECTION_NAME);
  // The demo exists to reach a first answer without setup, so a real connection
  // satisfies that step outright. Requiring the demo literally would leave an
  // established user — real databases, working key, never clicked the demo —
  // permanently one step short, nagged forever to install a database they do
  // not want.
  return [
    {
      key: 'llm',
      label: 'Configure an LLM',
      hint: 'Add a provider key so the agent can answer questions.',
      done: llmStatus === 'configured',
    },
    {
      key: 'demo',
      label: 'Try the sample database',
      hint: 'A small shop DB with a pre-seeded glossary — no setup needed.',
      done: hasDemo || hasReal,
    },
    {
      key: 'connect',
      label: 'Connect your database',
      hint: 'Point it at a real read-only database when you are ready.',
      done: hasReal,
    },
  ];
}

/** The card exists to get a user to their first answer; once every step is done
 *  it is pure clutter, so it stops rendering entirely. */
export function onboardingComplete(steps: OnboardingStep[]): boolean {
  return steps.every((s) => s.done);
}
