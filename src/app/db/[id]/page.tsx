import { redirect } from 'next/navigation';

export default async function WorkspaceIndex({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/db/${id}/chat`);
}
