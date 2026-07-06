import { redirect } from "next/navigation";

/**
 * Parent landing for `/dashboard/tools`.
 *
 * The tools live in child routes (`traffic-inspector`, `agent-bridge`) but there
 * was no parent page, so navigating to `/dashboard/tools` (and its RSC prefetch)
 * returned 404 (QA finding: "Dashboard tools parent route"). Redirect to the
 * default child so the parent path resolves cleanly instead of 404-ing.
 */
export default function ToolsIndexPage() {
  redirect("/dashboard/tools/traffic-inspector");
}
