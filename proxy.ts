// Runs before every API route. Its only job is to let a frontend on another address call the API
// (lib/agent/cors.ts). With SISU_CORS_ORIGINS unset it changes nothing.
import { type NextRequest, NextResponse } from "next/server";
import { corsHeaders } from "@/lib/agent/cors";

export function proxy(request: NextRequest) {
  const headers = corsHeaders(request.headers.get("origin"));
  // The browser's question before a cross-site request: answered here, so no route needs an OPTIONS handler.
  if (request.method === "OPTIONS") return new NextResponse(null, { status: 204, headers: headers ?? {} });
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(headers ?? {})) response.headers.set(name, value);
  return response;
}

export const config = { matcher: "/api/:path*" };
