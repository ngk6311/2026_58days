import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { loadConfig } from "./env.mjs";

const config = loadConfig();
const requestedTeamKey = process.argv[2] || "default";
const teamConfig =
  config.teams.find((team) => team.teamKey === requestedTeamKey) ??
  (() => {
    throw new Error(`Unknown team_key: ${requestedTeamKey}`);
  })();

const storageStatePath = path.resolve(teamConfig.storageStatePath);
fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto(teamConfig.partnersUrl, { waitUntil: "domcontentloaded" });

console.log(`Browser opened for team: ${teamConfig.teamName} (${teamConfig.teamKey})`);
console.log("Please log in and make sure you can see the partners page.");
console.log("Then return to this terminal and press Enter.");

const rl = readline.createInterface({ input, output });
await rl.question("");
rl.close();

await context.storageState({ path: storageStatePath });
await browser.close();

console.log(`Saved login state to ${storageStatePath}`);
