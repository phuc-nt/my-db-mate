import { redirect } from 'next/navigation';

/** Legacy route — the eval harness lives under the workspace Context section. */
export default async function LegacyEval({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/db/${id}/context/eval`);
}
