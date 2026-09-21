import { randomBytes } from "node:crypto";

const secret = () => randomBytes(32).toString("hex");

console.log("WEBHOOK_SECRET=" + secret());
console.log("ADMIN_TOKEN=" + secret());
console.log("\nStore these values safely. Do not paste them into wrangler.jsonc or messages.");
