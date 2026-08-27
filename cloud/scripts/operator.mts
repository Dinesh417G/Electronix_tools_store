// `npm run operator` — the cloud twin of `store-cli operator add|set-pin|list`.
//
// CLAUDE.md §11 is explicit that the first admin cannot come from the API:
// /api/v1/admin/operators needs an ADMIN token, which needs an ADMIN operator
// with a PIN, which on a fresh database does not exist. `store-cli operator
// add` is that bootstrap — and it needs a Rust toolchain and a direct Postgres
// connection, neither of which a machine deploying only the cloud app has.
// Without this file the deployed system has no way to reach its own console.
//
// `npm run seed -- --demo-operators` is NOT that path, for the reason §11
// gives: it also inserts a demo catalog, and nobody should commission a real
// store by deleting a fake one. Its PINs are published in this repo besides.
//
// This grants no privilege the caller lacked. Running it needs DATABASE_URL,
// and whoever holds that already owns every row in the database.
//
//   npm run operator -- list
//   npm run operator -- add --emp-code E1001 --name "S. Rao" --role ADMIN \
//                           --zk-user-id 1 [--department "Tool Crib"]
//   npm run operator -- set-pin --emp-code E1001
//
// The PIN is never passed as an argument — it would land in shell history and
// in the process list. It is read from a hidden prompt, or from stdin when
// there is no terminal, so CI can pipe one in.

import { createInterface } from "node:readline";

const ROLES = ["OPERATOR", "STOREKEEPER", "ADMIN"];

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf("--" + name);
  return i === -1 ? undefined : argv[i + 1];
}

/** Reads a PIN without echoing it. Falls back to stdin when not a terminal. */
async function readPin(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Suppress the echo of everything after the prompt itself.
  const out = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (s: string) => void };
  out._writeToOutput = (s: string) => {
    if (s.includes(prompt)) out.output.write(prompt);
  };
  return await new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      out.output.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const { sql } = await import("../src/lib/db.ts");

  try {
    if (command === "list") {
      const rows = await sql`
        select emp_code, full_name, role, zk_user_id, department, active,
               (pin_hash is not null) as has_pin
          from operators order by role, emp_code`;
      if (rows.length === 0) {
        console.log("No operators. Create the first admin with:");
        console.log('  npm run operator -- add --emp-code E1001 --name "Your Name" --role ADMIN');
        return;
      }
      for (const r of rows) {
        console.log(
          [
            r.emp_code.padEnd(8),
            String(r.role).padEnd(12),
            (r.zk_user_id ? "zk " + r.zk_user_id : "no zk id").padEnd(12),
            r.has_pin ? "pin set" : "NO PIN ",
            r.active ? "active" : "retired",
            r.full_name,
          ].join("  "),
        );
      }
      return;
    }

    if (command === "add") {
      const empCode = arg(argv, "emp-code");
      const name = arg(argv, "name");
      const role = (arg(argv, "role") ?? "OPERATOR").toUpperCase();
      const zk = arg(argv, "zk-user-id") ?? null;
      const department = arg(argv, "department") ?? null;

      if (!empCode || !name) {
        console.error("--emp-code and --name are required");
        process.exit(1);
      }
      if (!ROLES.includes(role)) {
        console.error("--role must be one of " + ROLES.join(", "));
        process.exit(1);
      }

      const [existing] = await sql`select id from operators where emp_code = ${empCode}`;
      if (existing) {
        console.error(empCode + " already exists. Use set-pin to change its PIN.");
        process.exit(1);
      }

      // An ADMIN with no PIN cannot log in, which would leave the console
      // unreachable in exactly the way this command exists to prevent.
      const pin = role === "OPERATOR" ? "" : await readPin("PIN for " + empCode + " (hidden): ");
      if (role !== "OPERATOR" && pin.length < 4) {
        console.error("A " + role + " needs a PIN of at least 4 digits to reach the console.");
        process.exit(1);
      }

      const { hashPin } = await import("../src/lib/auth.ts");
      const pinHash = pin ? await hashPin(pin) : null;

      await sql`
        insert into operators (emp_code, full_name, zk_user_id, pin_hash, role, department, active)
        values (${empCode}, ${name}, ${zk}, ${pinHash}, ${role}, ${department}, true)`;

      console.log("Created " + empCode + " (" + role + ")" + (pinHash ? " with a PIN." : "."));
      if (!zk) {
        console.log("No zk_user_id set — this operator cannot be identified by the door (§8).");
      }
      return;
    }

    if (command === "set-pin") {
      const empCode = arg(argv, "emp-code");
      if (!empCode) {
        console.error("--emp-code is required");
        process.exit(1);
      }
      const [op] = await sql`select id, role from operators where emp_code = ${empCode}`;
      if (!op) {
        console.error("No operator " + empCode);
        process.exit(1);
      }
      const pin = await readPin("New PIN for " + empCode + " (hidden): ");
      if (pin.length < 4) {
        console.error("PIN must be at least 4 digits.");
        process.exit(1);
      }
      const { hashPin } = await import("../src/lib/auth.ts");
      await sql`update operators set pin_hash = ${await hashPin(pin)} where id = ${op.id}`;
      console.log("PIN updated for " + empCode + ".");
      return;
    }

    console.error("Usage: npm run operator -- list | add | set-pin");
    console.error("  add     --emp-code E1001 --name \"S. Rao\" --role ADMIN [--zk-user-id 1] [--department X]");
    console.error("  set-pin --emp-code E1001");
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
