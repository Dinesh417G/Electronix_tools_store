// Serial numbers for one item.
//
// A serial identifies a *tool*, not a catalog line: forty identical inserts in
// bin A-01-1 are one item and forty stickers, and telling those forty apart is
// the whole point of the number.
//
// Three things this screen has to get right:
//
//   minting     numbers come from a Postgres sequence, so two storekeepers
//               minting at once cannot collide
//   editing     a crib with numbers already stencilled on its tools records
//               those instead of a second set — but never the same number twice
//   reprinting  a replacement sticker is the same number printed again. The
//               count goes up; no new row, no new number.

import { useCallback, useEffect, useState } from "react";
import { ApiError, OfflineError } from "../lib/api";
import type { adminApi, ToolSerial } from "../lib/admin";
import { Banner, BigButton, Spinner } from "../components/ui";

interface Props {
  client: ReturnType<typeof adminApi>;
  itemId: string;
  itemCode: string;
  onBack: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

export function Serials({ client, itemId, itemCode, onBack, onNotice, onError }: Props) {
  const [serials, setSerials] = useState<ToolSerial[] | null>(null);
  const [mintCount, setMintCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(() => {
    client
      .serialsForItem(itemId)
      .then(setSerials)
      .catch((err) => onError(describe(err)));
  }, [client, itemId, onError]);

  useEffect(load, [load]);

  const mint = async () => {
    setBusy(true);
    try {
      const minted = await client.mintSerials(itemId, mintCount);
      onNotice(
        minted.length === 1
          ? `${minted[0].serial_no} created. Print it before it goes on a tool.`
          : `${minted.length} serials created, ${minted[0].serial_no}–${minted[minted.length - 1].serial_no}.`,
      );
      load();
    } catch (err) {
      onError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (serial: ToolSerial) => {
    const next = draft.trim();
    setEditing(null);
    if (!next || next === serial.serial_no) return;

    try {
      await client.updateSerial(serial.id, { serial_no: next });
      onNotice(`Now ${next}.`);
      load();
    } catch (err) {
      // The 409 here is the useful one: it names the tool already carrying that
      // number, so the storekeeper knows which sticker to go and look at.
      onError(describe(err));
      load();
    }
  };

  const print = async (serial: ToolSerial, copies: number) => {
    setBusy(true);
    try {
      const result = await client.printSerial(serial.id, copies);

      if (result.mode === "BROWSER_PDF") {
        const blob = await client.labelSheet([serial.id], copies);
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank", "noopener");
        // Revoked late: revoking immediately races the new tab's load.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        onNotice(`${serial.serial_no} sent to the print dialogue.`);
      } else {
        onNotice(`${serial.serial_no} queued for the shop-floor printer.`);
      }
      load();
    } catch (err) {
      onError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const retire = async (serial: ToolSerial) => {
    try {
      await client.updateSerial(serial.id, {
        status: serial.status === "ACTIVE" ? "RETIRED" : "ACTIVE",
      });
      load();
    } catch (err) {
      onError(describe(err));
    }
  };

  if (!serials) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading serials" />
      </div>
    );
  }

  const unprinted = serials.filter((s) => s.print_count === 0).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} className="tap px-2 text-2xl text-slate-400">
          ←
        </button>
        <div>
          <h2 className="text-lg font-bold">Serial numbers</h2>
          <p className="text-xs text-slate-400">
            {itemCode} · {serials.length} tool{serials.length === 1 ? "" : "s"}
            {unprinted > 0 ? ` · ${unprinted} not yet printed` : ""}
          </p>
        </div>
      </div>

      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="text-xs font-semibold text-slate-400">How many to create</span>
          <input
            value={String(mintCount)}
            onChange={(e) => setMintCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
            inputMode="numeric"
            className="tap mt-1 w-full rounded-xl bg-slate-800 px-4 text-base"
          />
        </label>
        <BigButton onClick={mint} variant="primary" disabled={busy} className="px-6">
          Create
        </BigButton>
      </div>

      {serials.length === 0 && (
        <Banner tone="info">
          No serials yet. Create one per physical tool — the number goes on the sticker
          and the sticker goes on the tool.
        </Banner>
      )}

      <ul className="space-y-2">
        {serials.map((serial) => (
          <li
            key={serial.id}
            className={`rounded-2xl bg-slate-800 p-3 ${
              serial.status === "RETIRED" ? "opacity-60" : ""
            }`}
          >
            <div className="flex items-center gap-2">
              {editing === serial.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => saveEdit(serial)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit(serial);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="tap flex-1 rounded-lg bg-slate-900 px-3 font-mono text-base"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(serial.id);
                    setDraft(serial.serial_no);
                  }}
                  className="tap flex-1 text-left font-mono text-base font-semibold"
                >
                  {serial.serial_no}
                </button>
              )}

              {!serial.minted && (
                <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                  typed in
                </span>
              )}
              {serial.status === "RETIRED" && (
                <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs">retired</span>
              )}
            </div>

            <div className="pt-1 text-xs text-slate-500">
              {serial.print_count === 0
                ? "never printed"
                : `printed ${serial.print_count}×${
                    serial.last_printed_at
                      ? ` · last ${new Date(serial.last_printed_at).toLocaleDateString()}`
                      : ""
                  }`}
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => print(serial, 1)}
                className="tap flex-1 rounded-lg bg-slate-700 text-sm font-semibold"
              >
                {serial.print_count === 0 ? "Print" : "Reprint"}
              </button>
              <button
                type="button"
                onClick={() => retire(serial)}
                className="tap rounded-lg bg-slate-900 px-4 text-sm text-slate-400"
              >
                {serial.status === "ACTIVE" ? "Retire" : "Restore"}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <p className="text-xs text-slate-500">
        Tap a number to edit it. The same number can never be on two tools — the database
        refuses it, and the message says which tool already has it.
      </p>
    </div>
  );
}

function describe(err: unknown): string {
  // `OfflineError` says which of the three failures it was and how long we
  // waited; flattening that back to one sentence here is what made the last
  // report undiagnosable.
  if (err instanceof OfflineError) return err.message;
  if (err instanceof ApiError) return err.message;
  return "Something went wrong.";
}
