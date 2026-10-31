import { codeForStep } from "../services/totp.js";

const s = process.argv[2];
if (!s) { console.error("Usage: npm run totp -- SECRET"); process.exit(1); }
console.log(codeForStep(s, Math.floor(Date.now() / 30000)));