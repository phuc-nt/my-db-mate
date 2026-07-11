import { redirect } from 'next/navigation';

/** Legacy route — Context Studio now lives inside the per-connection workspace. */
export default async function LegacyContextStudio({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/db/${id}/context`);
}
