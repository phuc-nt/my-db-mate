import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { getModelForTest } from '../../../../services/llm-service';
import { getLlmSettings } from '../../../../services/settings-service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST { provider, model, apiKey? } → tries one tiny completion with the
 *  UNSAVED config (apiKey empty → reuse the stored key). Errors are sanitized:
 *  provider messages can echo URLs/keys, so only a trimmed message is returned. */
export async function POST(req: Request) {
  const body = await req.json();
  try {
    let apiKey: string = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey && body.provider !== 'ollama') {
      const stored = await getLlmSettings();
      if (!stored) return NextResponse.json({ ok: false, error: 'API key required' }, { status: 400 });
      apiKey = stored.apiKey;
    }
    const baseUrl = body.provider === 'ollama' && typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : undefined;
    const model = getModelForTest(body.provider, apiKey, String(body.model ?? ''), baseUrl);
    const res = await generateText({ model, prompt: 'Reply with the single word: ok', maxOutputTokens: 16 });
    return NextResponse.json({ ok: true, reply: res.text.slice(0, 50) });
  } catch (e) {
    let msg = e instanceof Error ? e.message : 'test failed';
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) msg = msg.split(body.apiKey.trim()).join('***');
    return NextResponse.json({ ok: false, error: msg.slice(0, 300) }, { status: 200 });
  }
}
