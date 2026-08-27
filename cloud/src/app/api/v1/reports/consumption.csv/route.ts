// GET /api/v1/reports/consumption.csv — the same report, as a file.
//
// The route segment really is called `consumption.csv`: §11 names the endpoint
// with the extension, and a storekeeper who pastes it into a browser should get
// a file named after what it holds rather than `route.csv` or a download called
// `consumption` with no extension at all.
//
// The `Content-Disposition` is what makes the browser save it instead of
// rendering four thousand rows of text.

import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { consumption, parseGroupBy, parseInstant, toCsv } from "@/lib/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);

  const p = new URL(request.url).searchParams;
  const groupBy = parseGroupBy(p.get("group_by"));

  const rows = await consumption(groupBy, {
    from: parseInstant(p.get("from"), "from"),
    to: parseInstant(p.get("to"), "to"),
  });

  return new Response(toCsv(groupBy, rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="consumption-by-${groupBy}.csv"`,
    },
  });
});
