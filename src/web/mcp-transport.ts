import { createRequire } from "node:module";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// SDK 1.32.1's StreamableHTTPClientTransport declaration conflicts with its own
// Transport interface under exactOptionalPropertyTypes (sessionId's getter may
// return undefined). Load its published CJS entry at this small runtime boundary
// so the rest of the project keeps strict library checks. The real SDK transport
// is exercised through Pi with JSON and SSE fixtures; no SDK files are patched.
// Remove this bridge when the pinned SDK fixes that declaration.
type TransportModule = {
  StreamableHTTPClientTransport: new (
    url: URL,
    options: {
      fetch: typeof fetch;
      requestInit: RequestInit;
      reconnectionOptions: {
        maxRetries: number;
        initialReconnectionDelay: number;
        maxReconnectionDelay: number;
        reconnectionDelayGrowFactor: number;
      };
    },
  ) => Transport;
};

const sdk = createRequire(import.meta.url)(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
) as TransportModule;
export const StreamableHTTPClientTransport = sdk.StreamableHTTPClientTransport;
