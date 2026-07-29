import { corsPreflight, withExtensionCors } from "../../../../lib/cors";
import { getPerspecticaChatGptAuth } from "../../../../lib/chatgpt-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const METHODS = "GET, POST, OPTIONS";

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, METHODS);
}

async function handle(request: Request): Promise<Response> {
  const response = await getPerspecticaChatGptAuth().handler(request);
  return withExtensionCors(request, response, METHODS);
}

export const GET = handle;
export const POST = handle;
