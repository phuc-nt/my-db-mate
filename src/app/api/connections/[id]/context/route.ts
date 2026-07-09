import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../../db/client';
import { tableAnnotations, columnAnnotations, glossaryTerms, manualRelationships, verifiedQueries } from '../../../../../db/context-schema';
import {
  upsertTableAnnotation, upsertColumnAnnotation, addGlossaryTerm, addManualRelationship, addVerifiedQuery, setVerifiedQueryDisabled,
} from '../../../../../services/context-service';

export const runtime = 'nodejs';

/** GET → all context for a connection (for Context Studio). Strips embeddings. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tables, columns, glossary, relationships, verified] = await Promise.all([
    db.select().from(tableAnnotations).where(eq(tableAnnotations.connectionId, id)),
    db.select().from(columnAnnotations).where(eq(columnAnnotations.connectionId, id)),
    db.select({ id: glossaryTerms.id, term: glossaryTerms.term, definition: glossaryTerms.definition, sqlMapping: glossaryTerms.sqlMapping, synonyms: glossaryTerms.synonyms }).from(glossaryTerms).where(eq(glossaryTerms.connectionId, id)),
    db.select().from(manualRelationships).where(eq(manualRelationships.connectionId, id)),
    db.select({ id: verifiedQueries.id, question: verifiedQueries.question, sql: verifiedQueries.sql, isDisabled: verifiedQueries.isDisabled }).from(verifiedQueries).where(eq(verifiedQueries.connectionId, id)),
  ]);
  return NextResponse.json({ tables, columns, glossary, relationships, verified });
}

/** POST → create/update a context item. Body: { type, ...fields }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  try {
    switch (body.type) {
      case 'table_annotation': await upsertTableAnnotation({ connectionId: id, ...body }); break;
      case 'column_annotation': await upsertColumnAnnotation({ connectionId: id, ...body }); break;
      case 'glossary': await addGlossaryTerm({ connectionId: id, ...body }); break;
      case 'relationship': await addManualRelationship({ connectionId: id, ...body }); break;
      case 'verified_query': await addVerifiedQuery({ connectionId: id, ...body }); break;
      case 'verified_query_disable': await setVerifiedQueryDisabled(body.queryId, body.disabled); break;
      default: return NextResponse.json({ error: 'unknown type' }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
