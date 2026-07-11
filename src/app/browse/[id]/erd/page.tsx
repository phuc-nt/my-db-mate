import { redirect } from 'next/navigation';

/** Legacy route — schema tools now live inside the per-connection workspace. */
export default async function LegacyBrowse({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/db/${id}/schema/erd`);
}
