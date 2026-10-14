/** npm run set-password -- <email> <password>  — gives an existing (e.g. seeded demo) student a login. */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { students } from "../db/schema.js";
import { hashPassword } from "../lib/auth.js";

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password || password.length < 8) throw new Error("Usage: npm run set-password -- <email> <password (8+ chars)>");
  const updated = await db.update(students).set({ passwordHash: hashPassword(password) }).where(eq(students.email, email.toLowerCase())).returning({ id: students.id });
  if (updated.length === 0) throw new Error(`No student with email ${email}.`);
  console.log(`Password set for ${email}.`);
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
