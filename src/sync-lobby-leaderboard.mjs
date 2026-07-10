import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { loadConfig } from "./env.mjs";
import { GoogleSheetsClient } from "./google-sheets.mjs";
import { formatDateTime } from "./time.mjs";

const TARGET_SPREADSHEET_IDS = [
  "1FauGZXtlj6EsAdXSDixCQ34xs853WkEb1vlO_LcsWgo",
];

const OUTPUT_SHEET_NAMES = {
  individual: "lobby_individual",
  squad: "lobby_squad",
  brigade: "lobby_brigade",
  brigadeCaptains: "lobby_brigade_captains",
};
const LEADERBOARD_TYPES = ["individual", "squad", "brigade"];
const LEADERBOARD_LIMIT = 1000;
const BRIGADE_CAPTAIN_IDENTITIES = new Set([
  "如來佛祖(大隊長)",
  "貪吃の寶(祐權專屬)",
  "霸氣の三(郁婷專屬)",
  "傲嬌の雪寶(彥甫專屬)",
]);

function requireStorageState(storageStatePath) {
  return path.resolve(storageStatePath);
}

function readAccessTokenFromStorageState(storageStatePath) {
  const raw = JSON.parse(readFileSync(storageStatePath, "utf8"));
  for (const origin of raw.origins ?? []) {
    for (const item of origin.localStorage ?? []) {
      if (item.name === "accessToken" && item.value) {
        return item.value;
      }
    }
  }
  throw new Error(`Missing accessToken in ${storageStatePath}. Please run auth again.`);
}

async function getLeaderboard(page, apiBase, type) {
  const url = `${apiBase}/leaderboard?type=${type}&limit=${LEADERBOARD_LIMIT}`;
  const result = await page.evaluate(async (requestUrl) => {
    const accessToken = localStorage.getItem("accessToken");
    const response = await fetch(requestUrl, {
      headers: {
        Accept: "application/json, text/plain, */*",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text,
    };
  }, url);

  if (!result.ok) {
    throw new Error(`Failed to fetch ${type} leaderboard: ${result.status} ${result.statusText}. ${result.text}`);
  }

  return JSON.parse(result.text);
}

function achievementNames(titles) {
  if (!Array.isArray(titles)) {
    return "";
  }
  return titles.map((item) => item?.name).filter(Boolean).join(", ");
}

function buildIndividualRows(leaderboard, syncedAt) {
  const rows = [
    ["同步時間", syncedAt],
    ["排名", "姓名", "身分", "總分", "成就", "user_id"],
  ];

  for (const entry of leaderboard?.entries ?? []) {
    rows.push([
      entry.rank ?? "",
      entry.display_name ?? "",
      entry.identity_name ?? "",
      entry.score ?? entry.value ?? "",
      achievementNames(entry.titles),
      entry.user_id ?? "",
    ]);
  }

  return rows;
}

function buildSquadRows(leaderboard, syncedAt) {
  const rows = [
    ["同步時間", syncedAt],
    ["排名", "小隊", "人數", "平均總分", "總分", "squad_id"],
  ];

  for (const entry of leaderboard?.entries ?? []) {
    rows.push([
      entry.rank ?? "",
      entry.squad_name ?? "",
      entry.member_count ?? "",
      entry.avg_score ?? entry.avg_value ?? "",
      entry.total_score ?? entry.total_value ?? "",
      entry.squad_id ?? "",
    ]);
  }

  return rows;
}

function buildBrigadeRows(leaderboard, syncedAt) {
  const rows = [
    ["同步時間", syncedAt],
    ["排名", "大隊", "人數", "小隊數", "平均總分", "總分", "標誌", "口號", "brigade_id"],
  ];

  for (const entry of leaderboard?.entries ?? []) {
    rows.push([
      entry.rank ?? "",
      entry.brigade_name ?? "",
      entry.member_count ?? "",
      entry.team_count ?? "",
      entry.avg_score ?? entry.avg_value ?? "",
      entry.total_score ?? entry.total_value ?? "",
      entry.emoji ?? "",
      entry.slogan ?? "",
      entry.brigade_id ?? "",
    ]);
  }

  return rows;
}

function buildBrigadeCaptainRows(leaderboards, syncedAt) {
  const brigadeByCaptainId = new Map();
  for (const entry of leaderboards.brigade?.entries ?? []) {
    if (entry.captain_id) {
      brigadeByCaptainId.set(entry.captain_id, entry);
    }
  }

  const rows = [
    ["同步時間", syncedAt],
    ["個人排名", "姓名", "身分", "總分", "大隊排名", "大隊", "大隊總分", "user_id", "brigade_id"],
  ];

  for (const entry of leaderboards.individual?.entries ?? []) {
    const identityName = entry.identity_name ?? "";
    if (!BRIGADE_CAPTAIN_IDENTITIES.has(identityName)) {
      continue;
    }

    const brigade = brigadeByCaptainId.get(entry.user_id);
    rows.push([
      entry.rank ?? "",
      entry.display_name ?? "",
      identityName,
      entry.score ?? entry.value ?? "",
      brigade?.rank ?? "",
      brigade?.brigade_name ?? "",
      brigade?.total_score ?? brigade?.total_value ?? "",
      entry.user_id ?? "",
      brigade?.brigade_id ?? "",
    ]);
  }

  return rows;
}

function buildLeaderboardSheets(leaderboards, syncedAt) {
  return {
    [OUTPUT_SHEET_NAMES.individual]: buildIndividualRows(leaderboards.individual, syncedAt),
    [OUTPUT_SHEET_NAMES.squad]: buildSquadRows(leaderboards.squad, syncedAt),
    [OUTPUT_SHEET_NAMES.brigade]: buildBrigadeRows(leaderboards.brigade, syncedAt),
    [OUTPUT_SHEET_NAMES.brigadeCaptains]: buildBrigadeCaptainRows(leaderboards, syncedAt),
  };
}

async function main() {
  const appConfig = loadConfig();
  const sourceTeam = appConfig.teams.find((team) => team.teamKey === "team7") ?? appConfig.teams[0];
  if (!sourceTeam) {
    throw new Error("No enabled team config available for lobby leaderboard auth.");
  }

  const storageStatePath = requireStorageState(sourceTeam.storageStatePath);
  readAccessTokenFromStorageState(storageStatePath);
  const apiBase = `${sourceTeam.apiBaseUrl}/api/v1/schools/${sourceTeam.schoolId}/fortune_game`;
  const syncedAt = formatDateTime(new Date(), appConfig.timezone);
  const leaderboards = {};

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  try {
    await page.goto(sourceTeam.partnersUrl, { waitUntil: "networkidle", timeout: 60000 });
    for (const type of LEADERBOARD_TYPES) {
      leaderboards[type] = await getLeaderboard(page, apiBase, type);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const sheets = buildLeaderboardSheets(leaderboards, syncedAt);

  for (const spreadsheetId of TARGET_SPREADSHEET_IDS) {
    const sheetsClient = new GoogleSheetsClient({
      ...appConfig.google,
      spreadsheetId,
    });
    await sheetsClient.ensureSheets(Object.keys(sheets));
    await sheetsClient.writeSheets(sheets);
    for (const [sheetName, rows] of Object.entries(sheets)) {
      console.log(`[lobby] Wrote ${rows.length} rows to ${spreadsheetId}/${sheetName}`);
    }
  }
}

await main();
