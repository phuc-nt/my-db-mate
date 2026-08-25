/**
 * Onboarding: public surface.
 *
 * Pure derivation over setup health — no DB access of its own, so the setup page
 * can render steps without a round trip per step.
 */
export { deriveOnboardingSteps, onboardingComplete } from './onboarding-steps';
export type { OnboardingStep } from './onboarding-steps';
