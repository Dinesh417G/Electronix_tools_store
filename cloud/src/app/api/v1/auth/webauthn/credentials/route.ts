// GET /api/v1/auth/webauthn/credentials — the operator's registered devices.
//
// Scoped to the caller, always. An operator listing another operator's devices
// learns which phones open the crib, which is reconnaissance dressed as a
// feature.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { credentialsForOperator } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  const auth = await requireRole(request, "OPERATOR", "STOREKEEPER", "ADMIN");
  const credentials = await credentialsForOperator(auth.operatorId);

  return NextResponse.json(
    credentials.map((c) => ({
      id: c.id,
      device_label: c.device_label,
      backed_up: c.backed_up,
      created_at: c.created_at,
      last_used_at: c.last_used_at,
      // The public key and credential id stay server-side. Neither is a secret,
      // and neither is any of the operator's business on this screen.
    })),
  );
});
