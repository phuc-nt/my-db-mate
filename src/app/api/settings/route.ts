import { NextResponse } from 'next/server';
import { getLlmSettingsPublic, saveLlmSettings, clearLlmSettings } from '../../../services/settings-service';

export const runtime = 'nodejs';

/** GET → public view of the LLM settings (never returns the key). */
export async function GET() {
  return NextResponse.json(await getLlmSettingsPublic());
}

/** PUT { provider, model, apiKey? } — empty apiKey keeps the stored one.
 *  PUT { clear: true } — drop the config (fall back to env OpenRouter). */
export async function PUT(req: Request) {
  const body = await req.json();
  try {
    if (body.clear === true) {
      await clearLlmSettings();
      return NextResponse.json({ ok: true });
    }
    const providers = ['openrouter', 'openai', 'anthropic', 'google'];
    if (!providers.includes(body.provider)) return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
    if (typeof body.model !== 'string' || !body.model.trim()) return NextResponse.json({ error: 'model required' }, { status: 400 });
    await saveLlmSettings({ provider: body.provider, model: body.model.trim(), apiKey: body.apiKey });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 });
  }
}
