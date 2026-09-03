// Personal sign-in (CLAUDE.md §11: "admin uses operator login").
//
// A separate credential from the device token on purpose. The terminal acts for
// whoever claimed the session; this acts for a named person.
//
// It used to refuse an OPERATOR outright, which was right about the console and
// wrong about everything else: §8's passkey routes all admit an OPERATOR, and
// this screen was the only door to the one that registers a device. An operator
// could therefore sign in with a fingerprint they had no way to enrol. Any role
// may sign in here now; the shell decides what they see, and an operator sees
// their own devices and nothing else.

import { useEffect, useState } from "react";
import { OfflineError } from "../lib/api";
import { login } from "../lib/admin";
import { isPasskeySupported, signInWithPasskeyAsOperator } from "../lib/passkey";
import { Banner, BigButton, Screen } from "../components/ui";

export function AdminLogin({
  onSignedIn,
  onCancel,
}: {
  onSignedIn: (token: string, name: string, role: string) => void;
  onCancel: () => void;
}) {
  const [empCode, setEmpCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyReady, setPasskeyReady] = useState(false);

  useEffect(() => {
    void isPasskeySupported().then(setPasskeyReady);
  }, []);

  const passkeySignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await signInWithPasskeyAsOperator();
      onSignedIn(result.token, result.full_name, result.role);
    } catch (err) {
      setError(
        err instanceof OfflineError
          ? "Cannot reach the store server."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await login(empCode.trim(), pin);
      onSignedIn(result.token, result.full_name, result.role);
    } catch (err) {
      setError(
        err instanceof OfflineError
          ? "Cannot reach the store server."
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
          <h1 className="text-2xl font-bold">Sign in</h1>
          <p className="pt-1 text-slate-400">
            Employee code and PIN. The session lasts 12 hours. Storekeepers and
            admins get the console; everybody else gets their own sign-in
            settings.
          </p>
        </div>

        {error && <Banner tone="error">{error}</Banner>}

        <label className="block">
          <span className="text-sm font-semibold text-slate-400">EMPLOYEE CODE</span>
          <input
            value={empCode}
            onChange={(e) => setEmpCode(e.target.value.toUpperCase())}
            autoComplete="username"
            className="tap mt-1 w-full rounded-xl bg-slate-800 px-4 text-lg outline-none focus:ring-2 focus:ring-sky-500"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-slate-400">PIN</span>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="current-password"
            onKeyDown={(e) => {
              if (e.key === "Enter" && empCode.trim() && pin) void submit();
            }}
            className="tap mt-1 w-full rounded-xl bg-slate-800 px-4 text-lg outline-none focus:ring-2 focus:ring-sky-500"
          />
        </label>

        <BigButton
          onClick={submit}
          variant="primary"
          className="w-full"
          disabled={busy || !empCode.trim() || !pin}
        >
          {busy ? "Signing in…" : "Sign in"}
        </BigButton>

        {passkeyReady && (
          <>
            <div className="flex items-center gap-3 pt-1">
              <span className="h-px flex-1 bg-slate-800" />
              <span className="text-xs text-slate-500">or</span>
              <span className="h-px flex-1 bg-slate-800" />
            </div>

            <BigButton onClick={passkeySignIn} className="w-full" disabled={busy}>
              Use fingerprint on this device
            </BigButton>

            {/* Said plainly, because a button that silently does nothing is
                worse than no button: a device has to be registered before it
                can sign in with a fingerprint. */}
            <p className="-mt-2 text-center text-xs text-slate-500">
              Only works once you have registered this device. Sign in with your
              PIN first, then add it under Fingerprint sign-in.
            </p>
          </>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="w-full rounded-xl px-4 py-3 text-sm text-slate-400 active:bg-slate-800"
        >
          Back to the terminal
        </button>
      </div>
    </Screen>
  );
}
