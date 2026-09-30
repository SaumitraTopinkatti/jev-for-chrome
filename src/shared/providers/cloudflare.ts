import { CloudflareConfig, JevRequest, JevResponse } from '../types';
import { postJson } from './http';

export async function callCloudflare(
  config: CloudflareConfig,
  request: JevRequest,
  options: { signal?: AbortSignal } = {}
): Promise<JevResponse> {
  const accountId = (config.accountId || '').trim();
  const apiToken = (config.apiToken || '').trim();
  if (!accountId || !apiToken) {
    throw new Error('Cloudflare Account ID and API Token must be configured. Please set them in Options.');
  }

  const endpoint =
    config.endpoint || `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
  const model = (config.model || '').trim() || 'typesafe/jev';

  const json = await postJson(
    endpoint,
    { Authorization: `Bearer ${apiToken}` },
    { model, input: { state: request.state, questions: request.questions } },
    { label: 'Cloudflare AI', signal: options.signal }
  );

  // Cloudflare can answer HTTP 200 with { success: false, errors: [...] }.
  if (json && typeof json === 'object' && (json as any).success === false) {
    const errors = (json as any).errors;
    const detail = Array.isArray(errors)
      ? errors.map((e) => (typeof e === 'string' ? e : e?.message || JSON.stringify(e))).join('; ')
      : JSON.stringify(errors ?? json).slice(0, 300);
    throw new Error(`Cloudflare AI error${detail ? `: ${detail}` : ''}`);
  }

  // Cloudflare wraps the response in { success: true, result: ... }
  if (json && typeof json === 'object' && 'result' in json && json.result) {
    const result = json.result;
    return {
      model: result.model || model,
      answers: result.answers || result,
      usage: result.usage,
    };
  }
  return json as JevResponse;
}
