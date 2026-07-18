/** Client helper: start an investigate-from-finding session and navigate to the
 *  chat page, which owns the agent stream (navigate-first flow — the conclusion's
 *  onFinish persistence must belong to a page that stays mounted). Shared by the
 *  Automations run history and the Data Health surfaces. */
export async function startInvestigation(
  connectionId: string,
  target: Record<string, unknown>,
  onError: (msg: string) => void,
): Promise<void> {
  const r = await fetch(`/api/connections/${connectionId}/investigate-finding`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(target),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { onError(d.error ?? 'investigate failed'); return; }
  window.location.href = `/db/${connectionId}/chat?session=${d.sessionId}&autostart=1`;
}
