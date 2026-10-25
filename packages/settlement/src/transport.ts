import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * HTTP boundary between the payer and payee roles. The payer sends the unchanged native MPP credential in
 * `Authorization` and the payer evidence ack, base64url JSON, in this header.
 */
export const ACK_HEADER = 'x-upay-payer-ack';

export type RequestHandler = (request: Request) => Promise<Response>;

export function incrementPath(sessionId: string, sequence: number): string {
  return `/sessions/${encodeURIComponent(sessionId)}/increments/${sequence}`;
}

export function encodeAckHeader(ack: unknown): string {
  return Buffer.from(JSON.stringify(ack)).toString('base64url');
}

export function decodeAckHeader(header: string): unknown {
  return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
}

/** Serves a Web `Request` handler on 127.0.0.1, so the payee runs as its own HTTP role. */
export async function serveHandler(handle: RequestHandler, onError?: (error: unknown) => void): Promise<{ url: string; stop(): Promise<void> }> {
  const http = createServer((req, res) => {
    handle(toWebRequest(req)).then(
      (response) => writeResponse(res, response),
      (error: unknown) => {
        onError?.(error);
        res.writeHead(500).end();
      },
    );
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve()))),
  };
}

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}
