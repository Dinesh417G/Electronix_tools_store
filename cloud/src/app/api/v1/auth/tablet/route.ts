// Device enrolment (CLAUDE.md §11).
//
// Typed once per phone or wall tablet by whoever sets it up. The secret is
// checked in constant time and the device gets a long-lived token; a tablet is
// not an operator, so this token identifies the *device* and nothing else.

import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";
import { enrolmentSecretMatches, issueToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  tablet_id: z.string().trim().min(1).max(64),
  name: z.string().trim().max(120).optional(),
  location: z.string().trim().max(120).optional(),
  enrolment_secret: z.string().min(1),
});

export const POST = handler(async (request: Request) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw ApiError.badRequest("malformed enrolment request", parsed.error.issues);
  }
  const body = parsed.data;

  if (!enrolmentSecretMatches(body.enrolment_secret)) {
    // Deliberately the same shape whatever was wrong. The device gets one
    // sentence; the deployment log gets the tablet id it was attempted for.
    console.warn("[auth] tablet enrolment refused", { tablet_id: body.tablet_id });
    throw ApiError.forbidden("That enrolment secret is not right.");
  }

  // Re-enrolling an existing device is normal — a cleared browser, a replaced
  // tablet, a factory reset. It keeps its id so its history stays attached.
  await sql`
    insert into tablets (tablet_id, name, location)
    values (${body.tablet_id}, ${body.name ?? null}, ${body.location ?? null})
    on conflict (tablet_id) do update
       set name         = coalesce(excluded.name, tablets.name),
           location     = coalesce(excluded.location, tablets.location),
           active       = true,
           last_seen_at = now()
  `;

  const token = await issueToken({ kind: "TABLET", tabletId: body.tablet_id });

  console.info("[auth] tablet registered", { tablet_id: body.tablet_id });
  return NextResponse.json({ tablet_id: body.tablet_id, token });
});
