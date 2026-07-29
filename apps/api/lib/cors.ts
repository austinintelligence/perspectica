export const DEFAULT_EXTENSION_ORIGIN = "chrome-extension://daefmnkkogfkfmmikoomfmkdkfknilff";

export function getExtensionOrigin(): string {
  return process.env.PERSPECTICA_EXTENSION_ORIGIN ?? DEFAULT_EXTENSION_ORIGIN;
}

export function isAllowedBrowserOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return (
    origin === null || origin === new URL(request.url).origin || origin === getExtensionOrigin()
  );
}

export function withExtensionCors(request: Request, response: Response, methods: string): Response {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin");
  if (origin === getExtensionOrigin()) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  headers.append("Vary", "Origin");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Allow-Methods", methods);
  headers.set("Access-Control-Max-Age", "600");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function corsPreflight(request: Request, methods: string): Response {
  if (!isAllowedBrowserOrigin(request)) {
    return Response.json({ error: "This browser origin is not allowed." }, { status: 403 });
  }
  return withExtensionCors(request, new Response(null, { status: 204 }), methods);
}
