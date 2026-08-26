/**
 * The checklist's whole value is that it reflects REAL state — a card claiming
 * "LLM configured" on an install that cannot answer a question is worse than no
 * card. These pin the derivation rules that the UI only draws.
 */
import { describe, expect, it } from 'vitest';
import { deriveOnboardingSteps, onboardingComplete } from '@/modules/onboarding/onboarding-steps';
import { DEMO_CONNECTION_NAME } from '@/core/lib/demo-constants';

const stepFor = (steps: ReturnType<typeof deriveOnboardingSteps>, key: string) =>
  steps.find((s) => s.key === key)!;

describe('deriveOnboardingSteps', () => {
  it('marks nothing done on a fresh install', () => {
    const steps = deriveOnboardingSteps({ llmStatus: 'missing', connectionNames: [] });
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(onboardingComplete(steps)).toBe(false);
  });

  // `placeholder` is the .env.example case: it looks like a key but cannot
  // answer, so it must NOT tick the box.
  it('counts only `configured` as an LLM, not missing or placeholder', () => {
    for (const status of ['missing', 'placeholder', 'error', undefined]) {
      expect(stepFor(deriveOnboardingSteps({ llmStatus: status, connectionNames: [] }), 'llm').done).toBe(false);
    }
    expect(stepFor(deriveOnboardingSteps({ llmStatus: 'configured', connectionNames: [] }), 'llm').done).toBe(true);
  });

  // The demo connection is created by us; counting it as "connected your
  // database" would tell users they finished a step they never did.
  it('does not let the demo satisfy the connect-your-own-database step', () => {
    const steps = deriveOnboardingSteps({ llmStatus: 'configured', connectionNames: [DEMO_CONNECTION_NAME] });
    expect(stepFor(steps, 'demo').done).toBe(true);
    expect(stepFor(steps, 'connect').done).toBe(false);
  });

  // The satisfaction between these two steps is deliberately one-way. A real
  // connection is a strictly better version of "try the sample database", so it
  // ticks both; the demo is NOT a substitute for connecting your own database,
  // so it ticks only its own step (the case just above).
  it('lets a real connection satisfy the demo step too', () => {
    const steps = deriveOnboardingSteps({ llmStatus: 'configured', connectionNames: ['prod-replica'] });
    expect(stepFor(steps, 'connect').done).toBe(true);
    expect(stepFor(steps, 'demo').done).toBe(true);
  });

  it('is complete only when all three are satisfied', () => {
    const steps = deriveOnboardingSteps({
      llmStatus: 'configured',
      connectionNames: [DEMO_CONNECTION_NAME, 'prod-replica'],
    });
    expect(onboardingComplete(steps)).toBe(true);
  });
});

/**
 * An install that predates this card must look exactly as it did before: real
 * connections, a working key, and no reason to have ever clicked the demo. If
 * the demo step demanded the demo connection literally, that user would be one
 * step short forever and the card would never stop rendering.
 */
describe('established install', () => {
  it('is complete with real connections and no demo', () => {
    const steps = deriveOnboardingSteps({
      llmStatus: 'configured',
      connectionNames: ['prod-readonly', 'analytics'],
    });
    expect(onboardingComplete(steps)).toBe(true);
  });

  it('is still incomplete when the key is the only thing missing', () => {
    const steps = deriveOnboardingSteps({
      llmStatus: 'placeholder',
      connectionNames: ['prod-readonly'],
    });
    expect(onboardingComplete(steps)).toBe(false);
    expect(steps.find((s) => s.key === 'llm')?.done).toBe(false);
  });
});
