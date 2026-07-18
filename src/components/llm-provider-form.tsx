'use client';

import { useEffect, useState } from 'react';

const PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'qwen/qwen3.7-max' },
  { id: 'openai', label: 'OpenAI', placeholder: 'gpt-5.2' },
  { id: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'claude-sonnet-5' },
  { id: 'google', label: 'Google (Gemini)', placeholder: 'gemini-3-flash' },
  { id: 'ollama', label: 'Ollama (local)', placeholder: 'qwen3' },
] as const;

const OLLAMA_DEFAULT_URL = 'http://localhost:11434/v1';

type ProviderId = (typeof PROVIDERS)[number]['id'];

/** LLM provider settings: pick a provider, paste an API key (stored encrypted,
 *  never shown again), name a model, Test before Save. Clearing the config falls
 *  back to the OPENROUTER_* env vars. */
export function LlmProviderForm() {
  const [provider, setProvider] = useState<ProviderId>('openrouter');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(OLLAMA_DEFAULT_URL);
  const [current, setCurrent] = useState<{ configured: boolean; provider?: string; model?: string; keyTail?: string; baseUrl?: string }>();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const d = await (await fetch('/api/settings')).json();
    setCurrent(d);
    if (d.configured) { setProvider(d.provider); setModel(d.model); if (d.baseUrl) setBaseUrl(d.baseUrl); }
  }
  useEffect(() => { load(); }, []);

  async function test() {
    setBusy(true); setMsg('Testing…');
    const r = await (await fetch('/api/settings/test-llm', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, model, apiKey, ...(provider === 'ollama' ? { baseUrl } : {}) }),
    })).json();
    setMsg(r.ok ? `✓ Provider replied: "${r.reply}"` : `✗ ${r.error}`);
    setBusy(false);
  }

  async function save() {
    setBusy(true); setMsg('Saving…');
    const r = await fetch('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, model, apiKey, ...(provider === 'ollama' ? { baseUrl } : {}) }),
    });
    const d = await r.json();
    setMsg(r.ok ? 'Saved ✓ — all features now use this provider' : `✗ ${d.error}`);
    setApiKey('');
    setBusy(false);
    load();
  }

  async function clearCfg() {
    if (!confirm('Clear the configured provider and fall back to the OPENROUTER_* env vars?')) return;
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clear: true }) });
    setMsg('Cleared — using env fallback');
    setModel(''); setApiKey('');
    load();
  }

  const ph = PROVIDERS.find((p) => p.id === provider)?.placeholder ?? '';

  return (
    <section className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="mb-1 text-sm font-semibold">LLM provider</h2>
      <p className="mb-3 text-xs text-neutral-500">
        Powers chat, follow-ups, reports, and mining.{' '}
        {current?.configured
          ? <>Currently: <b>{current.provider}</b> · {current.model} · key …{current.keyTail}</>
          : <>Currently: env fallback (OPENROUTER_API_KEY).</>}
      </p>
      <div className="mb-2 flex flex-wrap gap-2">
        {PROVIDERS.map((p) => (
          <button key={p.id} onClick={() => setProvider(p.id)}
            className={`rounded px-2 py-1 text-xs ${provider === p.id ? 'bg-blue-600 text-white' : 'border text-neutral-600 dark:text-neutral-300'}`}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="space-y-2 text-sm">
        {provider === 'ollama' ? (
          <input className="w-full rounded border p-2 dark:bg-neutral-900" placeholder={`Ollama base URL — e.g. ${OLLAMA_DEFAULT_URL}`}
            value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} data-testid="ollama-base-url" />
        ) : (
          <input type="password" autoComplete="off" className="w-full rounded border p-2 dark:bg-neutral-900"
            placeholder={current?.configured && current.provider === provider ? 'API key (leave blank to keep the stored key)' : 'API key'}
            value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        )}
        <input className="w-full rounded border p-2 dark:bg-neutral-900" placeholder={`Model — e.g. ${ph}`}
          value={model} onChange={(e) => setModel(e.target.value)} />
        <p className="text-xs text-neutral-400">
          {provider === 'ollama'
            ? 'No API key needed — inference runs on your own machine, nothing leaves it. Pick a tool-calling-capable model (qwen3, llama3.1+; ≥7B recommended — smaller models struggle with the agent loop). Hit Test to confirm the server responds before saving.'
            : 'Use an exact model ID your account can access (the placeholder is only an example). Hit Test to confirm before saving.'}
        </p>
        <div className="flex items-center gap-2">
          <button onClick={test} disabled={busy || !model.trim()} className="rounded border px-3 py-1 text-sm disabled:opacity-50">Test</button>
          <button onClick={save} disabled={busy || !model.trim()} className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50">Save</button>
          {current?.configured && <button onClick={clearCfg} className="text-xs text-neutral-500 hover:text-red-600">clear (use env)</button>}
        </div>
        {msg && <p className="text-xs text-amber-600">{msg}</p>}
      </div>
    </section>
  );
}
