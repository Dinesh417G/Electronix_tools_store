// POST /api/v1/auth/webauthn/register/verify

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { verifyRegistration } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler(async (request: Request) => {
  await requireRole(request, "OPERATOR", "STOREKEEPER", "ADMIN");

  const body = await request.json().catch(() => null);
  if (!body?.response) throw ApiError.badRequest("no registration response");

  const result = await verifyRegistration(request, body);

  return NextResponse.json({
    registered: true,
    ...result,
    // Surfaced rather than hidden: a synced passkey lives on every device that
    // platform account owns, which the operator should know before relying on
    // it as identity.
    note: result.backed_up
      ? "This passkey is synced to your platform account, so it exists on your other devices too."
      : "This passkey stays on this device only.",
  });
});
