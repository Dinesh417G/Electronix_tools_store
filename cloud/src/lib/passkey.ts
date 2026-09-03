// Passkey ceremonies, browser side.
//
// What the operator experiences: a fingerprint prompt on their own phone.
// What actually happens: the phone unlocks a private key in its secure enclave
// and signs our challenge. The fingerprint never leaves the device and never
// reaches us — which is why this is a privacy improvement over a shop-floor
// biometric system, not a compromise.
//
// @simplewebauthn/browser exists to do the base64url ↔ ArrayBuffer conversions
// that the raw API demands. Doing them by hand is how ceremonies fail with
// errors that name nothing.

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ApiError, getToken } from "./api";
import { fetchOrThrow } from "./offline";

/**
 * Whether this browser can do a passkey at all.
 *
 * Two separate questions, and the second is the one that matters here:
 * `PublicKeyCredential` exists in every modern browser, but a *platform*
 * authenticator — the built-in fingerprint sensor rather than a USB key — is
 * what this feature is for. A desktop with no sensor answers false, and the UI
 * hides the button rather than offering a prompt that cannot be satisfied.
 */
export async function isPasskeySupported(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!window.PublicKeyCredential) return false;

  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

async function post<T>(path: string, body?: unknown, token?: string): Promise<T> {
  // A ceremony has a person standing there with a finger on a sensor, so an
  // unbounded wait is worse here than anywhere: `get()` already failed once in
  // production with an error that named nothing, and a hang after it names
  // even less.
  const response = await fetchOrThrow(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `Request failed (${response.status}).`;
    let code = "error";
    try {
      const parsed = JSON.parse(text);
      message = parsed.message ?? message;
      code = parsed.error ?? code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(response.status, code, message);
  }

  return (await response.json()) as T;
}

/**
 * Register this device as a passkey for the signed-in operator.
 *
 * Requires an operator token: a passkey is only as trustworthy as the moment it
 * was enrolled, so enrolling one means first proving who you are by the means
 * that already exist.
 */
export async function registerPasskey(
  operatorToken: string,
  deviceLabel?: string,
): Promise<{ backed_up: boolean; note: string }> {
  const options = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "/api/v1/auth/webauthn/register/options",
    undefined,
    operatorToken,
  );

  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    throw friendly(err);
  }

  return post("/api/v1/auth/webauthn/register/verify", {
    response,
    device_label: deviceLabel ?? defaultLabel(),
  }, operatorToken);
}

export interface PasskeySession {
  session_id: string;
  operator_id: string;
  emp_code: string;
  full_name: string;
  state: string;
  manual_identity: boolean;
  identity_source: string;
  tablet_id: string;
}

/**
 * Sign in with a passkey.
 *
 * The device token rides along when the terminal is asking, which is what tells
 * the server to open a session rather than hand back an admin token.
 */
export async function signInWithPasskey(): Promise<PasskeySession> {
  const options = await post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/api/v1/auth/webauthn/login/options",
  );

  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    throw friendly(err, "signin");
  }

  return post<PasskeySession>(
    "/api/v1/auth/webauthn/login/verify",
    { response },
    getToken() ?? undefined,
  );
}

/** What the console gets back: a named operator and a 12 hour token. */
export interface PasskeyOperator {
  token: string;
  operator_id: string;
  emp_code: string;
  full_name: string;
  role: "OPERATOR" | "STOREKEEPER" | "ADMIN";
}

/**
 * Sign in to the admin console with a passkey.
 *
 * The same two endpoints as the terminal's sign-in, and the difference is one
 * header: `/login/verify` opens a *terminal session* when a device token is
 * present and returns an *operator token* when it is not. On an enrolled
 * tablet the device token is sitting in localStorage, so signing in to the
 * console has to deliberately withhold it — otherwise the console asks for a
 * login and gets a shop-floor session back.
 */
export async function signInWithPasskeyAsOperator(): Promise<PasskeyOperator> {
  const options = await post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/api/v1/auth/webauthn/login/options",
  );

  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    throw friendly(err, "signin");
  }

  // No token argument, deliberately. See above.
  return post<PasskeyOperator>("/api/v1/auth/webauthn/login/verify", { response });
}

/**
 * The browser's own errors are unhelpful on a shop floor, and one of them is
 * actively misleading: with no passkey registered for this site, `get()` fails
 * with exactly the same `NotAllowedError` as a cancelled prompt. The first
 * user read "the sensor did not read", concluded the fingerprint was broken,
 * and was right that something was wrong and wrong about what. Signing in and
 * registering therefore say different things about the same error.
 */
function friendly(err: unknown, context: "signin" | "register" = "register"): ApiError {
  const name = (err as { name?: string })?.name;
  switch (name) {
    case "NotAllowedError":
      return new ApiError(
        400,
        "cancelled",
        context === "signin"
          // Names the route the reader can actually walk. It used to say
          // "Setup → Passkeys", which was wrong twice over once operators could
          // register at all: that section is called Fingerprint sign-in now,
          // and an operator never sees Setup — they land on their own page the
          // moment they sign in. A message that sends somebody to a screen they
          // cannot reach is worse than the browser's own error, because they
          // believe it and go looking.
          ? "No fingerprint on this phone yet, or the prompt was cancelled. Sign in with your employee code and PIN below. To add this phone: ⚙ → admin, sign in, then register it there."
          : "Cancelled, or the sensor did not read. Try again.",
      );
    case "InvalidStateError":
      return new ApiError(409, "already", "This device is already registered.");
    case "NotSupportedError":
      return new ApiError(400, "unsupported", "This device cannot use a fingerprint here.");
    case "SecurityError":
      // Almost always the site being served over plain HTTP from something
      // other than localhost. Worth naming, because it looks like a broken
      // sensor and is not.
      return new ApiError(400, "insecure", "Fingerprint sign-in needs a secure (https) connection.");
    default:
      return new ApiError(400, "failed", "That did not work. Try again, or use your PIN.");
  }
}

/** A label the operator will recognise in a list of their devices. */
function defaultLabel(): string {
  if (typeof navigator === "undefined") return "This device";
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "Android phone";
  if (/iphone|ipad/i.test(ua)) return "iPhone or iPad";
  if (/windows/i.test(ua)) return "Windows PC";
  if (/mac/i.test(ua)) return "Mac";
  return "This device";
}
