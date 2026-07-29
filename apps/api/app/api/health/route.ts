export const runtime = "nodejs";

export function GET(): Response {
  return Response.json({
    ok: true,
    service: "perspectica-api",
    mode: process.env.PERSPECTICA_MODE ?? "chatgpt",
  });
}
