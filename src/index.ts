import { env } from 'cloudflare:workers';
import { McpAgent } from 'agents/mcp';
import { endpointURLString } from '@cloudflare/playwright';
// @ts-expect-error — internal library path, no declaration file
import { createConnection } from '../node_modules/@cloudflare/playwright-mcp/lib/esm/src/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ---------------------------------------------------------------------------
// Cookie tool schemas
// ---------------------------------------------------------------------------

const CookiesGetInputSchema = z.object({
  urls: z
    .array(z.string())
    .optional()
    .describe('Optional list of URLs to filter cookies by. Returns all cookies if omitted.'),
});

const CookiesSetInputSchema = z.object({
  cookies: z
    .array(
      z.object({
        name: z.string().describe('Cookie name'),
        value: z.string().describe('Cookie value'),
        url: z.string().optional().describe('URL to associate the cookie with'),
        domain: z.string().optional().describe('Cookie domain'),
        path: z.string().optional().describe('Cookie path'),
        expires: z.number().optional().describe('Cookie expiration as Unix epoch in seconds'),
        httpOnly: z.boolean().optional().describe('Whether the cookie is HTTP-only'),
        secure: z.boolean().optional().describe('Whether the cookie is secure'),
        sameSite: z
          .enum(['Strict', 'Lax', 'None'])
          .optional()
          .describe('Cookie SameSite attribute'),
      }),
    )
    .describe('Array of cookies to set'),
});

const CookiesClearInputSchema = z.object({
  name: z.string().optional().describe('Only clear cookies with this name'),
  domain: z.string().optional().describe('Only clear cookies for this domain'),
  path: z.string().optional().describe('Only clear cookies with this path'),
});

const COOKIE_TOOLS = [
  {
    name: 'browser_cookies_get',
    title: 'Get browser cookies',
    description:
      'Returns cookies from the browser context. Optionally filter by URL(s). Returns a JSON array of cookie objects.',
    inputSchema: zodToJsonSchema(CookiesGetInputSchema),
    annotations: {
      title: 'Get browser cookies',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'browser_cookies_set',
    title: 'Set browser cookies',
    description:
      'Adds one or more cookies to the browser context. Each cookie must have at least name, value, and either url or domain.',
    inputSchema: zodToJsonSchema(CookiesSetInputSchema),
    annotations: {
      title: 'Set browser cookies',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'browser_cookies_clear',
    title: 'Clear browser cookies',
    description:
      'Clears cookies from the browser context. Optionally filter by name, domain, and/or path. Clears all cookies if no filters are provided.',
    inputSchema: zodToJsonSchema(CookiesClearInputSchema),
    annotations: {
      title: 'Clear browser cookies',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Helper: format a text result for MCP
// ---------------------------------------------------------------------------
function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Create the connection promise (mirrors createMcpAgent but keeps .context)
// ---------------------------------------------------------------------------

const cdpEndpoint = endpointURLString(env.BROWSER);

const connectionPromise = createConnection({
  capabilities: ['core', 'tabs', 'pdf', 'history', 'wait', 'files', 'testing'],
  browser: { cdpEndpoint },
});

// Once the connection is resolved, wrap the server handlers to inject cookie tools.
const serverPromise = connectionPromise.then((connection: any) => {
  const server = connection.server;
  const context = connection.context;

  // --- Wrap ListToolsRequestSchema handler ---
  const originalListHandler = server._requestHandlers.get(
    ListToolsRequestSchema.shape.method.value,
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request: any) => {
    const result = originalListHandler
      ? await originalListHandler(request, {})
      : { tools: [] };
    return {
      ...result,
      tools: [...(result.tools || []), ...COOKIE_TOOLS],
    };
  });

  // --- Wrap CallToolRequestSchema handler ---
  const originalCallHandler = server._requestHandlers.get(
    CallToolRequestSchema.shape.method.value,
  );

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const toolName = request.params?.name;

    // ----- browser_cookies_get -----
    if (toolName === 'browser_cookies_get') {
      try {
        const params = CookiesGetInputSchema.parse(request.params?.arguments || {});
        const { browserContext } = await context._ensureBrowserContext();
        const cookies = params.urls?.length
          ? await browserContext.cookies(params.urls)
          : await browserContext.cookies();
        return textResult(JSON.stringify(cookies, null, 2));
      } catch (error) {
        return textResult(String(error), true);
      }
    }

    // ----- browser_cookies_set -----
    if (toolName === 'browser_cookies_set') {
      try {
        const params = CookiesSetInputSchema.parse(request.params?.arguments || {});
        const { browserContext } = await context._ensureBrowserContext();
        await browserContext.addCookies(params.cookies);
        return textResult(`Successfully set ${params.cookies.length} cookie(s).`);
      } catch (error) {
        return textResult(String(error), true);
      }
    }

    // ----- browser_cookies_clear -----
    if (toolName === 'browser_cookies_clear') {
      try {
        const params = CookiesClearInputSchema.parse(request.params?.arguments || {});
        const { browserContext } = await context._ensureBrowserContext();
        const options: Record<string, string> = {};
        if (params.name) options.name = params.name;
        if (params.domain) options.domain = params.domain;
        if (params.path) options.path = params.path;
        await browserContext.clearCookies(
          Object.keys(options).length > 0 ? options : undefined,
        );
        const filterDesc = Object.keys(options).length
          ? ` matching ${JSON.stringify(options)}`
          : '';
        return textResult(`Cookies cleared${filterDesc}.`);
      } catch (error) {
        return textResult(String(error), true);
      }
    }

    // ----- Delegate everything else to the original handler -----
    if (originalCallHandler) {
      return originalCallHandler(request, {});
    }
    return textResult(`Tool "${toolName}" not found`, true);
  });

  return server;
});

// ---------------------------------------------------------------------------
// Durable Object class (replaces createMcpAgent output)
// ---------------------------------------------------------------------------

export class PlaywrightMCP extends McpAgent {
  server = serverPromise;

  async init() {
    // No additional initialization needed — connection is created at module level.
  }
}

// ---------------------------------------------------------------------------
// Session-recovery fetch handler (unchanged from original)
// ---------------------------------------------------------------------------

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
  const namespace = env.MCP_OBJECT;
  const doId = namespace.idFromName(`streamable-http:${sessionId}`);
  const doStub = namespace.get(doId);

  await (doStub as any)._init(undefined);
  await (doStub as any).setInitialized();

  // Replay the original request.
  const retryRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bodyText,
  });

  return mcpHandler.fetch(retryRequest, env, ctx);
}

// ---------------------------------------------------------------------------
// Default fetch handler
// ---------------------------------------------------------------------------

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
