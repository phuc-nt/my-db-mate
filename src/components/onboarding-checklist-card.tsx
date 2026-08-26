'use client';

/**
 * First-run guidance on the Connections page: three steps from a blank install to
 * a first answer. It renders nothing once every step is done, so an established
 * install sees no card and no layout shift.
 */
import Link from 'next/link';
import { onboardingComplete, type OnboardingStep } from '@/modules/onboarding';

interface Props {
  steps: OnboardingStep[];
  /** Runs the same one-click demo the empty state offers. */
  onTryDemo: () => void;
  busy?: boolean;
}

export function OnboardingChecklistCard({ steps, onTryDemo, busy }: Props) {
  if (onboardingComplete(steps)) return null;
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div
      data-testid="onboarding-checklist"
      className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/40"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium">Getting started</h2>
        <span className="text-xs text-neutral-500">{doneCount} of {steps.length} done</span>
      </div>

      <ol className="space-y-2">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2 text-sm">
            <span className={s.done ? 'text-green-600' : 'text-neutral-400'}>{s.done ? '✓' : '○'}</span>
            <div className="flex-1">
              <span className={s.done ? 'text-neutral-500 line-through' : 'font-medium'}>{s.label}</span>
              {!s.done && <p className="text-xs text-neutral-500">{s.hint}</p>}
            </div>
            {!s.done && s.key === 'llm' && (
              <Link href="/settings" className="shrink-0 rounded bg-blue-600 px-3 py-1 text-xs text-white">
                Open Settings
              </Link>
            )}
            {!s.done && s.key === 'demo' && (
              <button
                onClick={onTryDemo}
                disabled={busy}
                className="shrink-0 rounded border border-blue-600 px-3 py-1 text-xs text-blue-700 disabled:opacity-50 dark:text-blue-300"
              >
                {busy ? 'Setting up…' : 'Try it'}
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
