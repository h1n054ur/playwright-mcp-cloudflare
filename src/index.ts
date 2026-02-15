import { env } from 'cloudflare:workers';

import { createMcpAgent } from '@cloudflare/playwright-mcp';

export const PlaywrightMCP = createMcpAgent(env.BROWSER);

/**
 * Wraps the Streamable HTTP /mcp endpoint with session recovery.
 *
 * Problem: The `agents` SDK stores an "initialized" flag in Durable Object
 * storage when a session is first created. If that flag is lost (DO eviction,
 * redeployment, or storage reset), subsequent requests with the old
 * mcp-session-id get a 404 "Session not found" — and the MCP client (OpenCode)
 * has no automatic reconnect logic.
 *
 * Fix: When we detect the 404 "Session not found" response, we directly call
 * _init() and setInitialized() on the DO stub to re-establish the session, then
 * replay the original request. The client never sees the error.
 */
async function handleMcpWithSessionRecovery(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const mcpHandler = PlaywrightMCP.serve('/mcp');
  const sessionId = request.headers.get('mcp-session-id');

  // No existing session — nothing to recover, pass straight through.
  if (!sessionId) {
    return mcpHandler.fetch(request, env, ctx);
  }

  // Buffer the body upfront so we can replay it if we need to retry.
  // The SDK's serve() calls request.json() which consumes the stream.
  const bodyText = await request.text();

  const firstAttempt = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bodyText,
  });

  const response = await mcpHandler.fetch(firstAttempt, env, ctx);

  // Happy path — not a 404, return as-is.
  if (response.status !== 404) {
    return response;
  }

  // Check if it's specifically the "Session not found" error.
  const responseBody = await response.text();
  if (!responseBody.includes('Session not found')) {
    return new Response(responseBody, {
      status: response.status,
      headers: response.headers,
    });
  }

  console.log(
    `[mcp-recovery] Session ${sessionId} not found. Re-initializing DO and retrying.`,
  );

  // Re-initialize the Durable Object for this session directly.
  // This mirrors what the SDK does on an initialization request (lines 656-658
  // of agents/dist/mcp/index.js).
  const namespace = env.MCP_OBJECT;
  const doId = namespace.idFromName(`streamable-http:${sessionId}`);
  const doStub = namespace.get(doId);

  await doStub._init(undefined);
  await doStub.setInitialized();

  // Replay the original request — the DO is now initialized so it won't 404.
  const retryRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bodyText,
  });

  return mcpHandler.fetch(retryRequest, env, ctx);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);

    switch (pathname) {
      case '/sse':
      case '/sse/message':
        return PlaywrightMCP.serveSSE('/sse').fetch(request, env, ctx);
      case '/mcp':
        return handleMcpWithSessionRecovery(request, env, ctx);
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};
