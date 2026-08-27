// Passkeys — §8's fourth identity source, on a screen.
//
// Everything behind this existed already: migration 0007, lib/webauthn.ts,
// lib/passkey.ts and five routes. The terminal could *sign in* with a passkey.
// Nothing could register one, list which devices were registered, or revoke one
// — `registerPasskey()` had no caller anywhere in the app, and the credentials
// endpoints had no client at all. So an operator whose phone was lost had no
// way to remove its credential short of SQL. §11 calls an endpoint with no
// screen this project's known failure mode; this closes the last instance of it.
//
// Why the admin console and not the terminal, where an operator actually
// stands: 0007 says it plainly — a passkey registered on a shared wall tablet
// identifies the tablet, not the operator, because Android lets several
// fingerprints unlock the same credential. Registration therefore belongs
// behind a personal sign-in, on the device that is going to be the key.
//
// Registration requires an operator token (§8): a passkey is only as
// trustworthy as the moment it was enrolled, so enrolling one means first
// proving who you are by the means that already exist.

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import type { Passkey, adminApi } from "../lib/admin";
import { isPasskeySupported, registerPasskey } from "../lib/passkey";
import { Banner, Header, Spinner } from "../components/ui";

export function Passkeys({
  client,
  token,
  operatorName,
  onBack,
  onError,
  onNotice,
}: {
  client: ReturnType<typeof adminApi>;
  token: string;
  operatorName: string;
  onBack: () => void;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [credentials, setCredentials] = useState<Passkey[] | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    client
      .passkeys()
      .then(setCredentials)
      .catch((err) => {
        onError(describe(err));
        setCredentials([]);
      });
  }, [client, onError]);

  useEffect(load, [load]);
  useEffect(() => {
    void isPasskeySupported().then(setSupported);
  }, []);

  const register = async () => {
    setBusy(true);
    try {
      const result = await registerPasskey(token);
      onNotice(
        result.backed_up
          ? "Registered. This passkey is backed up, so it survives losing the device."
          : "Registered. This passkey lives only on this device — losing it means registering again.",
      );
      load();
    } catch (err) {
      onError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await client.revokePasskey(id);
      onNotice("Revoked. That device can no longer sign in.");
      setConfirming(null);
      load();
    } catch (err) {
      onError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  if (!credentials) return <Spinner label="Reading your devices…" />;

  return (
    <div className="space-y-4">
      <Header
        title="Passkeys"
        subtitle={`Devices that can sign in as ${operatorName}`}
        onBack={onBack}
      />

      {supported === false && (
        <Banner tone="warn">
          This browser has no passkey support, so nothing can be registered here.
          Existing devices below still work, and can still be revoked.
        </Banner>
      )}

      {credentials.length === 0 && (
        <Banner tone="info">
          No passkey is registered. Sign-in still works with an employee code and
          PIN — a passkey is the stronger of the two, and neither is as strong as
          the door reader (§8).
        </Banner>
      )}

      <section className="space-y-2">
        {credentials.map((credential) => (
          <div key={credential.id} className="rounded-xl bg-slate-900 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">
                {credential.device_label ?? "Unnamed device"}
              </span>
              {credential.backed_up && (
                <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                  backed up
                </span>
              )}
            </div>
            <div className="mt-1 text-sm text-slate-400">
              Registered {shortDate(credential.created_at)} ·{" "}
              {credential.last_used_at
                ? `last used ${shortDate(credential.last_used_at)}`
                : "never used"}
            </div>

            {confirming === credential.id ? (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revoke(credential.id)}
                  className="tap rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  Yes, revoke it
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="tap rounded-lg bg-slate-800 px-3 py-2 text-sm"
                >
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(credential.id)}
                className="tap mt-3 rounded-lg bg-slate-800 px-3 py-2 text-sm text-red-300"
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </section>

      <button
        type="button"
        disabled={busy || supported !== true}
        onClick={() => void register()}
        className="tap w-full rounded-xl bg-sky-600 px-4 py-3 font-semibold disabled:opacity-50"
      >
        {busy ? "Working…" : "Register this device"}
      </button>

      <p className="text-sm text-slate-500">
        A passkey proves that <em>this device</em> was unlocked by someone it
        trusts — not whose finger it was. That is why a session opened with one
        is still marked as not having come from the door, and why registering on
        a shared tablet is refused (§8).
      </p>
    </div>
  );
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
