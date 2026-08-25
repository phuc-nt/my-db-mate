/**
 * Render a proposal as files for the owner's data team.
 *
 * The proposal travels back from the client because it is not persisted — only
 * adoption is. That round trip means the body is untrusted input, so it is
 * re-parsed here against the same schema the service produces. What comes back
 * is TEXT: a `.sql` file of DDL or a dbt scaffold, for humans to review and run
 * under their own credentials. This route executes nothing.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConnection } from '@/core/connections/connection-service';
import { exportProposal, ValidatedProposalSchema } from '@/modules/datamart';
import { requireModule } from '@/core/require-module';

export const runtime = 'nodejs';

const BodySchema = z.object({
  proposal: ValidatedProposalSchema,
  target: z.enum(['bq-ddl', 'dbt']),
  targetDataset: z.string().max(200).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const disabled = requireModule('datamart');
  if (disabled) return disabled;
  const { id } = await params;
  const conn = await getConnection(id);
  if (!conn) return NextResponse.json({ error: 'connection not found' }, { status: 404 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Malformed proposal payload.' }, { status: 400 });
  }
  const { proposal, target, targetDataset } = parsed.data;
  return NextResponse.json({ files: exportProposal(proposal, target, targetDataset || 'marts') });
}
