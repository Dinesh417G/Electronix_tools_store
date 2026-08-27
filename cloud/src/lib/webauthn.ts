// Passkeys — the phone's own fingerprint sensor as an identity source (§8).
//
// The ceremonies are delegated to @simplewebauthn/server on purpose. Verifying
// a WebAuthn assertion by hand means parsing COSE keys, checking ES256/RS256
// signatures, hashing the RP id, comparing origins and handling sign counters —
// a list where every item is a quiet authentication hole if it is subtly wrong.
// This file owns the policy; the library owns the cryptography.
//
// What we store is a public key and a counter. No biometric data reaches the
// server, and nothing here could be replayed against another system.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { sql } from "./db.ts";
import { ApiError } from "./api-error.ts";

/**
 * Relying-party identity.
 *
 * `rpID` is a bare domain — no scheme, no port — and the browser refuses a
 * ceremony whose rpID is not a registrable suffix of the page's origin. Getting
 * this wrong fails at the authenticator with a message that names nothing, so
 * both values are read from the environment and stated in one place.
 *
 * localhost is the one origin the spec exempts from HTTPS, which is what makes
 * local development possible at all.
 */
export function relyingParty(request: Request) {
  const url = new URL(request.url);
  const origin = process.env.WEBAUTHN_ORIGIN ?? url.origin;
  const rpID = process.env.WEBAUTHN_RP_ID ?? url.hostname;
  return { origin, rpID, rpName: "ElectronIx Tool Store" };
}

export interface StoredCredential {
  id: string;
  operator_id: string;
  credential_id: string;
  public_key: string;
  sign_count: string;
  transports: string | null;
  device_label: string | null;
  backed_up: boolean;
  created_at: Date;
  last_used_at: Date | null;
}

// ── Challenges ────────────────────────────────────────────────────────────
//
// Stored rather than held in memory: a ceremony is two requests, and a
// serverless function has no "between" — the second may land on a different
// instance entirely.

async function storeChallenge(
  challenge: string,
  purpose: "REGISTER" | "AUTHENTICATE",
  operatorId: string | null,
): Promise<void> {
  await sql`
    insert into webauthn_challenges (challenge, purpose, operator_id)
    values (${challenge}, ${purpose}, ${operatorId})
  `;
  // Opportunistic sweep. There is no cron here, and a challenge table that only
  // ever grows is a slow leak nobody notices until it is large.
  void sql`delete from webauthn_challenges where expires_at < now()`.catch(() => {});
}

/**
 * Consume a challenge.
 *
 * Deleted as it is read, in one statement: a challenge is single-use, and
 * checking then deleting leaves a window where two concurrent requests both
 * pass. `delete … returning` closes it.
 */
async function takeChallenge(
  challenge: string,
  purpose: "REGISTER" | "AUTHENTICATE",
): Promise<{ operator_id: string | null }> {
  const rows = await sql<{ operator_id: string | null }[]>`
    delete from webauthn_challenges
     where challenge = ${challenge}
       and purpose = ${purpose}
       and expires_at > now()
     returning operator_id
  `;
  const row = rows[0];
  if (!row) {
    throw ApiError.badRequest(
      "That sign-in attempt has expired. Try again.",
    );
  }
  return row;
}

// ── Registration ──────────────────────────────────────────────────────────

export async function registrationOptions(
  request: Request,
  operator: { id: string; emp_code: string; full_name: string },
) {
  const { rpID, rpName } = relyingParty(request);

  const existing = await sql<{ credential_id: string; transports: string | null }[]>`
    select credential_id, transports from webauthn_credentials
     where operator_id = ${operator.id} and revoked_at is null
  `;

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: operator.emp_code,
    userDisplayName: operator.full_name,
    // Stable across re-registrations so the platform replaces the operator's
    // passkey rather than accumulating one per attempt.
    userID: new TextEncoder().encode(operator.id),
    attestationType: "none",
    // Already-registered credentials are excluded so the authenticator says
    // "you already have one" instead of silently creating a duplicate.
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? (JSON.parse(c.transports) as never) : undefined,
    })),
    authenticatorSelection: {
      // `platform` is the built-in sensor — the phone's own fingerprint reader,
      // not a USB key. A roaming key would work cryptographically but defeats
      // the point: the operator already carries the phone.
      authenticatorAttachment: "platform",
      // Discoverable, so the terminal can offer "sign in" with no employee code
      // typed first. The phone knows who it is.
      residentKey: "required",
      // The whole reason this exists. Without it the platform may hand back a
      // signature on presence alone — a tap, not a fingerprint.
      userVerification: "required",
    },
  });

  await storeChallenge(options.challenge, "REGISTER", operator.id);
  return options;
}

export async function verifyRegistration(
  request: Request,
  body: { response: Parameters<typeof verifyRegistrationResponse>[0]["response"]; device_label?: string },
) {
  const { origin, rpID } = relyingParty(request);

  const clientData = JSON.parse(
    Buffer.from(body.response.response.clientDataJSON, "base64url").toString(),
  ) as { challenge: string };

  const { operator_id } = await takeChallenge(clientData.challenge, "REGISTER");
  if (!operator_id) throw ApiError.badRequest("that challenge has no operator");

  const verification = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: clientData.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw ApiError.badRequest("That device could not be registered.");
  }

  const { credential, credentialBackedUp } = verification.registrationInfo;

  await sql`
    insert into webauthn_credentials
      (operator_id, credential_id, public_key, sign_count, transports,
       device_label, backed_up)
    values (
      ${operator_id},
      ${credential.id},
      ${Buffer.from(credential.publicKey).toString("base64url")},
      ${credential.counter},
      ${credential.transports ? JSON.stringify(credential.transports) : null},
      ${body.device_label ?? null},
      ${credentialBackedUp}
    )
  `;

  return { credential_id: credential.id, backed_up: credentialBackedUp };
}

// ── Authentication ────────────────────────────────────────────────────────

export async function authenticationOptions(request: Request) {
  const { rpID } = relyingParty(request);

  const options = await generateAuthenticationOptions({
    rpID,
    // Empty: the credentials are discoverable, so the phone offers the right
    // passkey without us naming it — and we avoid handing an unauthenticated
    // caller a list of who is enrolled.
    allowCredentials: [],
    userVerification: "required",
  });

  await storeChallenge(options.challenge, "AUTHENTICATE", null);
  return options;
}

export async function verifyAuthentication(
  request: Request,
  response: Parameters<typeof verifyAuthenticationResponse>[0]["response"],
): Promise<{ operatorId: string; credentialId: string }> {
  const { origin, rpID } = relyingParty(request);

  const clientData = JSON.parse(
    Buffer.from(response.response.clientDataJSON, "base64url").toString(),
  ) as { challenge: string };

  await takeChallenge(clientData.challenge, "AUTHENTICATE");

  const rows = await sql<StoredCredential[]>`
    select * from webauthn_credentials
     where credential_id = ${response.id} and revoked_at is null
  `;
  const stored = rows[0];
  // Same message whether the credential is unknown or the signature is wrong:
  // one tells an attacker which credential ids exist, the other does not.
  const refuse = () => ApiError.unauthorized("That device is not recognised.");
  if (!stored) throw refuse();

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: clientData.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: stored.credential_id,
      publicKey: new Uint8Array(Buffer.from(stored.public_key, "base64url")),
      counter: Number(stored.sign_count),
      transports: stored.transports ? (JSON.parse(stored.transports) as never) : undefined,
    },
  });

  if (!verification.verified) throw refuse();

  const { newCounter } = verification.authenticationInfo;

  // A counter that fails to advance means the credential has been cloned — the
  // library rejects that above, and this records the new value so the next
  // assertion is checked against it. Authenticators that always report zero are
  // permitted by the spec and simply never trip the check.
  await sql`
    update webauthn_credentials
       set sign_count = ${newCounter}, last_used_at = now()
     where id = ${stored.id}
  `;

  return { operatorId: stored.operator_id, credentialId: stored.credential_id };
}

export async function credentialsForOperator(operatorId: string) {
  return sql<StoredCredential[]>`
    select id, operator_id, credential_id, public_key, sign_count, transports,
           device_label, backed_up, created_at, last_used_at
      from webauthn_credentials
     where operator_id = ${operatorId} and revoked_at is null
     order by created_at
  `;
}

export async function revokeCredential(id: string, operatorId: string) {
  const rows = await sql<{ id: string }[]>`
    update webauthn_credentials set revoked_at = now()
     where id = ${id} and operator_id = ${operatorId} and revoked_at is null
     returning id
  `;
  if (!rows[0]) throw ApiError.notFound("no such device");
}
