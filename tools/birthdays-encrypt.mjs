// Encrypt the weather board's birthday list so it can live in the public repo/site.
//
//   BKEY='<passphrase>' node tools/birthdays-encrypt.mjs birthdays.json > public/weather/birthdays.enc.json
//
// Input (keep it OUT of the repo):
//   { "people": [ { "n": "Name", "m": 11, "d": 1, "y": 1998|null, "g": "family"|"groom"|"bride"|"guest" } ] }
//
// The board derives the same AES-GCM key with PBKDF2 from the passphrase, which a
// device stores once via /weather/#bkey=<passphrase> (see weather.js "birthdays").
import { readFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const pass = process.env.BKEY;
const file = process.argv[2];
if (!pass || !file) {
  console.error("usage: BKEY='<passphrase>' node tools/birthdays-encrypt.mjs <birthdays.json>");
  process.exit(1);
}
const plain = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(plain.people)) throw new Error("expected { people: [...] }");

const iter = 250000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
  base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(plain)));
const b64 = u => Buffer.from(u).toString("base64");
process.stdout.write(JSON.stringify({ v: 1, iter, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) }) + "\n");
