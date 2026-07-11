import { redirect } from 'next/navigation';

/** Legacy route — the chat now lives inside the per-connection workspace. */
export default async function LegacyChat({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/db/${id}/chat`);
}
