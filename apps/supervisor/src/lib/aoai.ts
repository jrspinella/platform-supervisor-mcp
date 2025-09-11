import fetch from 'node-fetch';

export type AoaiConfig = {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion?: string;
};

export async function chat(config: AoaiConfig, messages: Array<{ role: 'system'|'user'|'assistant'; content: string }>, opts?: { temperature?: number; max_tokens?: number }) {
  const url = `${config.endpoint.replace(/\/?$/, '')}/openai/deployments/${encodeURIComponent(config.deployment)}/chat/completions?api-version=${encodeURIComponent(config.apiVersion || '2024-05-01-preview')}`;
  const body = {
    messages,
    temperature: opts?.temperature ?? 0.2,
    max_tokens: opts?.max_tokens ?? 600,
    top_p: 0.9,
  } as any;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': config.apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`AOAI ${res.status}`);
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content?.trim?.() || '';
}

export function configuredFromEnv(): AoaiConfig | null {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini';
  if (!endpoint || !apiKey) return null;
  return { endpoint, apiKey, deployment, apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-05-01-preview' };
}