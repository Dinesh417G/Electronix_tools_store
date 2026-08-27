// Device enrolment (CLAUDE.md §11: `POST /api/v1/auth/tablet`).
//
// Done once per phone or tablet, by whoever sets the device up. The enrolment
// secret is shared and typed here rather than embedded in the build, so a
// stolen APK or a bookmarked URL is not by itself a working terminal.

import { useState } from "react";
import { ApiError, OfflineError, api, saveCredentials } from "../lib/api";
import { Banner, BigButton, Screen } from "../components/ui";

/** A default that names the device, so the admin device list is readable. */
function suggestTerminalId(): string {
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `WEB-${random}`;
}

export function Enrol({ onEnrolled }: { onEnrolled: () => void }) {
  const [terminalId, setTerminalId] = useState(suggestTerminalId);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.enrol(terminalId.trim(), name.trim() || terminalId.trim(), secret);
      saveCredentials(result.tablet_id, result.token);
      onEnrolled();
    } catch (err) {
      setError(
        err instanceof ApiError && err.isUnauthorized
          ? "That enrolment secret is not right."
          : err instanceof OfflineError
            ? "Cannot reach the store server. Check the address and the network."
            : err instanceof Error
              ? err.message
              : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <div className="flex flex-1 flex-col justify-center gap-5 px-5">
        <div>
          <h1 className="text-2xl font-bold">Set up this device</h1>
          <p className="pt-1 text-slate-400">
            One time only. Ask the storekeeper for the enrolment secret.
          </p>
        </div>

        {error && <Banner tone="error">{error}</Banner>}

        <label className="block">
          <span className="text-sm font-semibold text-slate-400">TERMINAL ID</span>
          <input
            value={terminalId}
            onChange={(e) => setTerminalId(e.target.value.toUpperCase())}
            className="tap mt-1 w-full rounded-xl bg-slate-800 px-4 text-lg outline-none focus:ring-2 focus:ring-sky-500"
          />
          <span className="text-xs text-slate-500">
            Shown on ledger rows and on the admin device list.
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-slate-400">NAME (OPTIONAL)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Store door tablet"
            className="tap mt-1 w-full rounded-xl bg-slate-800 px-4 text-lg outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-slate-400">ENROLMENT SECRET</span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            className="tap mt-1 w-full rounded-xl bg-slate-800 px-4 text-lg outline-none focus:ring-2 focus:ring-sky-500"
          />
        </label>

        <BigButton
          onClick={submit}
          variant="primary"
          className="w-full"
          disabled={busy || !terminalId.trim() || !secret}
        >
          {busy ? "Enrolling…" : "Enrol this device"}
        </BigButton>
      </div>
    </Screen>
  );
}
