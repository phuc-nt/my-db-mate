import { LlmProviderForm } from '../../components/llm-provider-form';
import { ApiKeyPanel } from '../../components/api-key-panel';

/** Global settings: LLM provider (chat/reports/mining all use it) and API keys
 *  for MCP/HTTP access. Connection-specific automation lives in each workspace. */
export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Settings</h1>
      <LlmProviderForm />
      <ApiKeyPanel />
    </main>
  );
}
