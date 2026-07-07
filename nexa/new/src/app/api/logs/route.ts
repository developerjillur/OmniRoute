import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

/**
 * GET /api/logs — root compatibility endpoint.
 *
 * The logs surface is split into sub-routes (`/api/logs/detail`, `/export`,
 * `/[id]`, `/console`) but there was no root route, so callers (and the CLI/docs)
 * hitting `/api/logs` received a 404 (QA finding: "Route contract drift"). This
 * returns an authenticated summary + links payload so `/api/logs` is a valid,
 * discoverable root while the detailed data stays behind the specific sub-routes.
 */
export async function GET(req: NextRequest) {
  const authError = await requireManagementAuth(req);
  if (authError) return authError;
  return NextResponse.json({
    ok: true,
    message: "OmniRoute logs API root. Use the sub-routes for data.",
    endpoints: {
      detail: "/api/logs/detail",
      export: "/api/logs/export",
      byId: "/api/logs/{id}",
      console: "/api/logs/console",
    },
  });
}
