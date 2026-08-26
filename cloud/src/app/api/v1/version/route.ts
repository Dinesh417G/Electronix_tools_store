// Build identity. Unauthenticated on purpose: a terminal needs to know whether
// it is running the build the server is serving before it has enrolled.

import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  return NextResponse.json({
    version: process.env.npm_package_version ?? "0.1.0",
    git_sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    built_at: process.env.VERCEL_DEPLOYMENT_ID ?? "dev",
    region: process.env.VERCEL_REGION ?? "local",
  });
});
