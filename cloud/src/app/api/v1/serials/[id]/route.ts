// GET   /api/v1/serials/{id}
// PATCH /api/v1/serials/{id}   edit the number, retire the tool, add a note
//
// The number is editable so a crib with numbers already stencilled on its tools
// can record those. What is not negotiable is uniqueness: the unique index
// refuses a number already on another tool, and that surfaces as 409.

import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, requireRole } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { getSerial, updateSerial } from "@/lib/serials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await authenticate(request);
    const { id } = await ctx.params;
    return NextResponse.json(await getSerial(id));
  },
);

const Patch = z.object({
  serial_no: z.string().trim().min(1).max(64).optional(),
  status: z.enum(["ACTIVE", "RETIRED"]).optional(),
  note: z.string().max(500).nullish(),
});

export const PATCH = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const parsed = Patch.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw ApiError.badRequest("nothing valid to change", parsed.error.issues);

    return NextResponse.json(await updateSerial(id, parsed.data));
  },
);
