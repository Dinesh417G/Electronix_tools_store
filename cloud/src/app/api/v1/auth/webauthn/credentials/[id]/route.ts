// DELETE /api/v1/auth/webauthn/credentials/{id} — forget a device.
//
// Revoked rather than deleted, so "this phone could open the crib until the
// 14th" stays answerable after the phone is gone.

import { requireRole } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { revokeCredential } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await requireRole(request, "OPERATOR", "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    // Scoped to the caller: revoking is only ever your own device.
    await revokeCredential(id, auth.operatorId);
    return new Response(null, { status: 204 });
  },
);
