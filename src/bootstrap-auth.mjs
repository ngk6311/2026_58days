import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { loadConfig } from "./env.mjs";

const config = loadConfig();
const authDir = path.resolve(".auth");
const storageStatePath = path.join(authDir, "storage-state.json");

fs.mkdirSync(authDir, { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto(config.partnersUrl, { waitUntil: "domcontentloaded" });

console.log("Browser opened.");
console.log("Please log in and make sure you can see the partners page.");
console.log("Then return to this terminal and press Enter.");

const rl = readline.createInterface({ input, output });
await rl.question("");
rl.close();

await context.storageState({ path: storageStatePath });
await browser.close();

console.log(`Saved login state to ${storageStatePath}`);
