import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { loadConfig } from "./env.mjs";
import { GoogleSheetsClient } from "./google-sheets.mjs";
import {
  addDays,
  enumerateDateKeys,
  formatDateTime,
  todayKey,
  weekStartKey,
  zonedDateKey,
} from "./time.mjs";

dns.setDefaultResultOrder("ipv4first");

const API_FETCH_TIMEOUT_MS = 20000;
const API_FETCH_MAX_ATTEMPTS = 4;

const SHEET_NAMES = [
  "task_rules",
  "members",
  "raw_logs",
  "quest_catalog",
  "daily_status",
  "weekly_status",
  "weekly_dashboard",
  "weekly_history",
  "run_log",
];

const TASK_RULE_HEADERS = [
  "rule_id",
  "active",
  "task_name",
  "period",
  "match_type",
  "match_value",
  "required_count",
  "notes",
];

const MEMBER_HEADERS = [
  "team_id",
  "team_name",
  "member_id",
  "student_id",
  "member_name",
  "identity_name",
  "is_team_captain",
  "is_brigade_captain",
  "today_score",
  "weekly_score",
  "total_score",
];

const RAW_LOG_HEADERS = [
  "log_id",
  "member_id",
  "student_id",
  "member_name",
  "team_id",
  "team_name",
  "quest_title",
  "source_type",
  "points",
  "logged_at",
  "logical_date",
  "fetched_at",
];

const QUEST_CATALOG_HEADERS = [
  "quest_title",
  "times_seen",
  "last_seen_at",
  "sample_member",
  "sample_team",
];

const DAILY_HEADERS = [
  "date",
  "team_name",
  "member_name",
  "task_name",
  "required_count",
  "actual_count",
  "completed",
  "matched_quests",
  "last_completed_at",
];

const WEEKLY_HEADERS = [
  "week_start",
  "week_end",
  "team_name",
  "member_name",
  "task_name",
  "required_count",
  "actual_count",
  "completed",
  "matched_quests",
  "last_completed_at",
];

const RUN_LOG_HEADERS = [
  "synced_at",
  "scope",
  "member_count",
  "log_count",
  "daily_rows",
  "weekly_rows",
  "notes",
];

const WEEKLY_DASHBOARD_HEADERS = [
  "隊員",
  "今日分數",
  "本週分數",
  "總分",
  "個人排名",
  "週一定課",
  "週二定課",
  "週三定課",
  "週四定課",
  "週五定課",
  "週六定課",
  "週日定課",
  "圓夢計畫親證 (2次)",
  "欣賞夥伴",
  "主題親證",
  "天使通話 (1次)",
  "蓋婭的召喚 (1次)",
  "親證分享 (1次)",
  "參加心成活動 (2次)",
  "實體小組定聚 (2次)",
  "巔峰取經試煉 (1次)",
  "解圓夢計畫 (1次)",
  "親證班課後課 (1次)",
  "參加結業典禮 (1次)",
  "傳愛",
];

const BRIGADE_WEEKLY_DASHBOARD_HEADERS = ["小組", ...WEEKLY_DASHBOARD_HEADERS];
const WEEKLY_HISTORY_DASHBOARD_HEADERS = [
  WEEKLY_DASHBOARD_HEADERS[0],
  "當週總分",
  "當週加分",
  ...WEEKLY_DASHBOARD_HEADERS.slice(5),
];
const BRIGADE_WEEKLY_HISTORY_DASHBOARD_HEADERS = ["小組", ...WEEKLY_HISTORY_DASHBOARD_HEADERS];

const CAMPAIGN_WEEKS = [
  { weekLabel: "第1週", start: "2026-05-25", end: "2026-05-31", cycle: 1 },
  { weekLabel: "第2週", start: "2026-06-01", end: "2026-06-07", cycle: 1 },
  { weekLabel: "第3週", start: "2026-06-08", end: "2026-06-14", cycle: 2 },
  { weekLabel: "第4週", start: "2026-06-15", end: "2026-06-21", cycle: 2 },
  { weekLabel: "第5週", start: "2026-06-22", end: "2026-06-28", cycle: 3 },
  { weekLabel: "第6週", start: "2026-06-29", end: "2026-07-05", cycle: 3 },
  { weekLabel: "第7週", start: "2026-07-06", end: "2026-07-12", cycle: 4 },
  { weekLabel: "第8週", start: "2026-07-13", end: "2026-07-19", cycle: 4 },
  { weekLabel: "第9週", start: "2026-07-20", end: "2026-07-21", cycle: 5 },
];

const SPECIAL_EVENT_START = "2026-06-01";
const FIFTH_WEEK_PROOF_REVIEW_GRACE = {
  questTitle: "親證分享",
  weekStart: "2026-06-22",
  weekEnd: "2026-06-28",
  graceStart: "2026-06-29",
  graceEnd: "2026-07-01",
};
const DAILY_TASK_COLUMN_COUNT = 7;
const SCORE_COLUMN_COUNT = 3;
const WEEKLY_DASHBOARD_SCORE_COLUMN_COUNT = SCORE_COLUMN_COUNT + 1;
const LEGACY_WEEKLY_TASK_COLUMN_COUNT = 7;
const LEADERBOARD_LIMIT = 1000;
const SCORE_LOG_LIMIT_MAX = 100;
const SELF_SCORE_LOG_LIMIT_MAX = 50;
const SELF_SCORE_LOG_MAX_PAGES = 50;

function requireStorageState(storageStatePath) {
  const filePath = path.resolve(storageStatePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing storage state: ${filePath}. Run auth for this team first.`);
  }
  return filePath;
}

function readAccessTokenFromStorageState(storageStatePath) {
  const raw = JSON.parse(fs.readFileSync(storageStatePath, "utf8"));
  for (const origin of raw.origins ?? []) {
    for (const item of origin.localStorage ?? []) {
      if (item.name === "accessToken" && item.value) {
        return item.value;
      }
    }
  }
  throw new Error(`Missing accessToken in ${storageStatePath}. Please run auth again.`);
}

function boolCell(value) {
  return value ? "TRUE" : "FALSE";
}

function parseSchoolSlugFromPartnersUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length >= 2 && segments[1] === "fortune-game") {
      return segments[0];
    }
    return segments[0] ?? null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFetchErrorCode(error) {
  return (
    error?.cause?.code ??
    error?.cause?.errors?.find((item) => item?.code)?.code ??
    error?.code ??
    error?.name ??
    "unknown"
  );
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetriableFetchError(error) {
  const code = getFetchErrorCode(error);
  return ["AbortError", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(code);
}

async function fetchWithRetry(url, options = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= API_FETCH_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!isRetriableStatus(response.status) || attempt === API_FETCH_MAX_ATTEMPTS) {
        return response;
      }

      await response.arrayBuffer().catch(() => null);
      const delayMs = 1000 * 2 ** (attempt - 1);
      console.log(
        `[FortuneAPI] ${response.status} on attempt ${attempt}/${API_FETCH_MAX_ATTEMPTS}, retrying in ${delayMs / 1000}s...`,
      );
      await sleep(delayMs);
    } catch (error) {
      lastError = error;
      if (!isRetriableFetchError(error) || attempt === API_FETCH_MAX_ATTEMPTS) {
        throw error;
      }

      const delayMs = 1000 * 2 ** (attempt - 1);
      console.log(
        `[FortuneAPI] fetch ${getFetchErrorCode(error)} on attempt ${attempt}/${API_FETCH_MAX_ATTEMPTS}, retrying in ${
          delayMs / 1000
        }s...`,
      );
      await sleep(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

async function resolveSchoolId(teamConfig, authToken) {
  const schoolSlug = parseSchoolSlugFromPartnersUrl(teamConfig.partnersUrl);
  if (!schoolSlug) {
    throw new Error(`Could not resolve school slug from ${teamConfig.partnersUrl}`);
  }

  const url = `${teamConfig.apiBaseUrl}/api/v1/public/schoolsInfo/${schoolSlug}`;
  const response = await fetchWithRetry(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve school id: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const schoolId = data?.schoolInfo?.id ?? data?.id ?? data?.school?.id ?? null;
  if (!schoolId) {
    throw new Error(`Could not resolve school id for slug ${schoolSlug}`);
  }
  return schoolId;
}

async function getJson(url, authToken) {
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} (${url})`);
  }

  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ");
    const contentType = response.headers.get("content-type") || "unknown content type";
    throw new Error(`Expected JSON but got ${contentType} from ${url}. Snippet: ${snippet}`);
  }
}

async function getJsonOptional(url, authToken, allowedStatuses = [401, 403, 404]) {
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
  });

  const text = await response.text();
  if (response.ok) {
    try {
      return JSON.parse(text);
    } catch {
      const snippet = text.slice(0, 200).replace(/\s+/g, " ");
      const contentType = response.headers.get("content-type") || "unknown content type";
      throw new Error(`Expected JSON but got ${contentType} from ${url}. Snippet: ${snippet}`);
    }
  }

  if (allowedStatuses.includes(response.status)) {
    return null;
  }

  throw new Error(`Request failed: ${response.status} ${response.statusText} (${url})`);
}

async function fetchIndividualLeaderboardRanks(teamConfig, schoolId, authToken) {
  const apiBase = `${teamConfig.apiBaseUrl}/api/v1/schools/${schoolId}/fortune_game`;
  const leaderboard = await getJson(
    `${apiBase}/leaderboard?type=individual&limit=${LEADERBOARD_LIMIT}`,
    authToken,
  );
  const byId = new Map();
  const byName = new Map();

  for (const entry of leaderboard?.entries ?? []) {
    const rank = entry.rank ?? "";
    if (entry.user_id) {
      byId.set(entry.user_id, rank);
    }
    if (entry.display_name) {
      byName.set(entry.display_name, rank);
    }
  }

  return { byId, byName };
}

async function getCachedIndividualLeaderboardRanks(leaderboardCache, teamConfig, schoolId, authToken) {
  const cacheKey = `${teamConfig.apiBaseUrl}::${schoolId}`;
  if (leaderboardCache.has(cacheKey)) {
    return {
      ranks: leaderboardCache.get(cacheKey),
      fromCache: true,
    };
  }

  const ranks = await fetchIndividualLeaderboardRanks(teamConfig, schoolId, authToken);
  leaderboardCache.set(cacheKey, ranks);
  return {
    ranks,
    fromCache: false,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function normalizeMember(team, member) {
  return {
    teamId: team.id ?? team.team_id ?? "",
    teamName: team.name ?? team.team_name ?? "",
    memberId: member.id ?? member.member_id ?? member.student_id ?? "",
    studentId: member.student_id ?? "",
    memberName: member.display_name ?? member.student_id ?? "",
    identityName: member.identity_name ?? "",
    isTeamCaptain: Boolean(member.is_team_captain),
    isBrigadeCaptain: Boolean(member.is_brigade_captain),
    todayScore: Number(member.today_score ?? 0),
    weeklyScore: Number(member.weekly_score ?? 0),
    totalScore: Number(member.total_score ?? 0),
  };
}

function compareMembersForDisplay(a, b, { groupByTeam = true } = {}) {
  if (a.isBrigadeCaptain !== b.isBrigadeCaptain) {
    return a.isBrigadeCaptain ? -1 : 1;
  }
  if (a.isTeamCaptain !== b.isTeamCaptain) {
    return a.isTeamCaptain ? -1 : 1;
  }
  if (groupByTeam) {
    const teamCompare = a.teamName.localeCompare(b.teamName, "zh-Hant");
    if (teamCompare !== 0) {
      return teamCompare;
    }
  }
  return a.memberName.localeCompare(b.memberName, "zh-Hant");
}

function buildLogRow(log, member, fetchedAt, logicalDate) {
  return {
    logId: log.id ?? "",
    memberId: member.memberId,
    studentId: member.studentId,
    memberName: member.memberName,
    teamId: member.teamId,
    teamName: member.teamName,
    questTitle: log.quest_title ?? "",
    sourceType: log.source_type ?? "",
    points: Number(log.points ?? 0),
    loggedAt: log.logged_at ?? "",
    logicalDate,
    weeklyLogicalDate: logicalDate,
    fetchedAt,
  };
}

async function fetchSelfScoreLogs(apiBase, authToken, limit) {
  const pageLimit = Math.min(limit, SELF_SCORE_LOG_LIMIT_MAX);
  const logs = [];
  const seenPageCursors = new Set();
  let lastLoggedAt = "";

  for (let pageIndex = 0; pageIndex < SELF_SCORE_LOG_MAX_PAGES; pageIndex += 1) {
    const params = new URLSearchParams({ limit: String(pageLimit) });
    if (lastLoggedAt) {
      params.set("last_logged_at", lastLoggedAt);
    }

    const pageLogs = await getJson(`${apiBase}/my-score-logs?${params.toString()}`, authToken);
    if (!Array.isArray(pageLogs) || pageLogs.length === 0) {
      break;
    }

    logs.push(...pageLogs);

    const nextCursor = pageLogs.at(-1)?.logged_at ?? "";
    if (!nextCursor || pageLogs.length < pageLimit || seenPageCursors.has(nextCursor)) {
      break;
    }

    seenPageCursors.add(nextCursor);
    lastLoggedAt = nextCursor;
  }

  return logs;
}

async function collectExtraSelfMembersAndLogs(teamConfig, appConfig, schoolId, scoreResetHour, fetchedAt) {
  const members = [];
  const rawLogs = [];
  const notes = [];

  for (const extraMember of teamConfig.extraSelfMembers ?? []) {
    const storageStatePath = requireStorageState(extraMember.storageStatePath);
    const authToken = readAccessTokenFromStorageState(storageStatePath);
    const apiBase = `${teamConfig.apiBaseUrl}/api/v1/schools/${schoolId}/fortune_game`;
    const [profile, studentProfile] = await Promise.all([
      getJson(`${apiBase}/me`, authToken),
      getJsonOptional(`${teamConfig.apiBaseUrl}/api/v1/students/me`, authToken),
    ]);

    const studentId = profile?.student_id ?? studentProfile?.id ?? "";
    const memberName = extraMember.memberName || studentProfile?.display_name || studentId || extraMember.key;
    const member = {
      teamId: extraMember.teamId || profile?.team_id || profile?.brigade_id || extraMember.key,
      teamName: extraMember.teamName || teamConfig.teamName,
      memberId: studentId || extraMember.key,
      studentId,
      memberName,
      identityName: extraMember.identityName,
      isTeamCaptain: Boolean(profile?.is_captain),
      isBrigadeCaptain: Boolean(profile?.is_brigade_captain),
      todayScore: Number(profile?.today_score_accumulated ?? 0),
      weeklyScore: Number(profile?.weekly_score_accumulated ?? 0),
      totalScore: Number(profile?.total_score ?? 0),
    };
    members.push(member);

    const logs = await fetchSelfScoreLogs(apiBase, authToken, appConfig.logLimit);
    for (const log of logs) {
      const logicalDate = log.logged_at
        ? zonedDateKey(new Date(log.logged_at), appConfig.timezone, scoreResetHour)
        : "";
      rawLogs.push(buildLogRow(log, member, fetchedAt, logicalDate));
    }

    notes.push(`${extraMember.key}: ${logs.length} self score logs`);
  }

  return { members, rawLogs, notes };
}

function isMondayDateKey(dateKey) {
  if (!dateKey) {
    return false;
  }
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay() === 1;
}

function themeProofCycleNumber(questTitle) {
  const normalizedQuestTitle = questTitle.replace(/\s+/g, "");
  const match = normalizedQuestTitle.match(/主題親證(\d+)/);
  return match ? Number(match[1]) : null;
}

function themeProofCycleRange(cycleNumber) {
  const cycleWeeks = CAMPAIGN_WEEKS.filter((week) => week.cycle === cycleNumber);
  if (cycleWeeks.length === 0) {
    return null;
  }
  return {
    start: cycleWeeks[0].start,
    end: cycleWeeks[cycleWeeks.length - 1].end,
  };
}

function applyFifthWeekProofReviewGrace(rawLogs) {
  const rule = FIFTH_WEEK_PROOF_REVIEW_GRACE;
  const graceLogsByMember = new Map();

  for (const log of rawLogs) {
    if (
      log.questTitle !== rule.questTitle ||
      log.logicalDate < rule.graceStart ||
      log.logicalDate > rule.graceEnd
    ) {
      continue;
    }

    // The normal Monday rollover may already have moved this record. Reset it
    // first so only one delayed approval per member can be assigned to week 5.
    log.weeklyLogicalDate = log.logicalDate;
    if (!graceLogsByMember.has(log.memberId)) {
      graceLogsByMember.set(log.memberId, []);
    }
    graceLogsByMember.get(log.memberId).push(log);
  }

  const membersWithFifthWeekProof = new Set(
    rawLogs
      .filter(
        (log) =>
          log.questTitle === rule.questTitle &&
          log.weeklyLogicalDate >= rule.weekStart &&
          log.weeklyLogicalDate <= rule.weekEnd,
      )
      .map((log) => log.memberId),
  );

  for (const [memberId, graceLogs] of graceLogsByMember) {
    if (membersWithFifthWeekProof.has(memberId)) {
      continue;
    }
    graceLogs.sort((a, b) => {
      const timeCompare = String(a.loggedAt).localeCompare(String(b.loggedAt));
      return timeCompare || String(a.logId).localeCompare(String(b.logId));
    });
    graceLogs[0].weeklyLogicalDate = rule.weekEnd;
  }
}

function adjustWeeklyLogicalDates(rawLogs) {
  const shouldCountAsPreviousWeekOnMonday = (questTitle) =>
    questTitle === "親證分享" || questTitle.includes("主題親證");
  const campaignStart = CAMPAIGN_WEEKS[0].start;

  for (const log of rawLogs) {
    log.weeklyLogicalDate = log.logicalDate;
    if (!shouldCountAsPreviousWeekOnMonday(log.questTitle) || !isMondayDateKey(log.logicalDate)) {
      continue;
    }

    const previousDate = addDays(log.logicalDate, -1);
    const themeCycleNumber = themeProofCycleNumber(log.questTitle);
    if (themeCycleNumber) {
      const cycleRange = themeProofCycleRange(themeCycleNumber);
      if (cycleRange && previousDate >= cycleRange.start && previousDate <= cycleRange.end) {
        log.weeklyLogicalDate = previousDate;
      }
      continue;
    }

    if (previousDate >= campaignStart) {
      log.weeklyLogicalDate = previousDate;
    }
  }

  applyFifthWeekProofReviewGrace(rawLogs);

  return rawLogs;
}

async function collectMembersAndLogs(teamConfig, appConfig, schoolId, authToken) {
  const apiBase = `${teamConfig.apiBaseUrl}/api/v1/schools/${schoolId}/fortune_game`;
  const expectsBrigadeRole = teamConfig.roleType === "brigade";
  const [teamData, publicConfig] = await Promise.all([
    getJsonOptional(`${apiBase}/my-team/members`, authToken, [401, 403, 404, 409]),
    getJson(`${apiBase}/config/public`, authToken),
  ]);
  const brigadeData = await getJsonOptional(`${apiBase}/my-brigade`, authToken);

  const scoreResetHour = Number(publicConfig?.score_reset_hour ?? appConfig.scoreResetHour);
  const fetchedAt = formatDateTime(new Date(), appConfig.timezone);
  const members = [];
  const rawLogs = [];
  const logIds = new Set();

  const currentTeamId = teamData?.team?.id ?? null;
  const hasBrigadeAccess = brigadeData?.viewer_role === "brigade_captain";
  const useBrigadeMode = expectsBrigadeRole || hasBrigadeAccess;

  if (expectsBrigadeRole && !brigadeData) {
    throw new Error(`Expected brigade access for ${teamConfig.teamKey}, but /my-brigade is unavailable.`);
  }

  const notes = [useBrigadeMode ? "brigade captain" : "team leader/member"];

  const teamsToSync = [];
  const addTeamToSync = (team) => {
    if (!team?.teamId || teamsToSync.some((item) => item.teamId === team.teamId)) {
      return;
    }
    teamsToSync.push(team);
  };

  if (useBrigadeMode) {
    for (const team of brigadeData?.teams ?? []) {
      addTeamToSync({
        teamId: team.team_id,
        teamName: team.team_name,
        isCurrentTeam: !expectsBrigadeRole && currentTeamId ? team.team_id === currentTeamId : false,
      });
    }
    if (expectsBrigadeRole && teamData?.team) {
      addTeamToSync({
        teamId: teamData.team.id,
        teamName: teamData.team.name,
        isCurrentTeam: true,
      });
      notes.push("included current team for brigade captain");
    }
  } else if (teamData?.team) {
    addTeamToSync({
      teamId: teamData.team.id,
      teamName: teamData.team.name,
      isCurrentTeam: true,
    });
  }

  const teamMemberMap = new Map();
  if (teamData?.team) {
    teamMemberMap.set(
      teamData.team.id,
      (teamData.members ?? []).map((member) => normalizeMember(teamData.team, member)),
    );
  }

  if (useBrigadeMode) {
    for (const team of teamsToSync) {
      if (teamMemberMap.has(team.teamId)) {
        continue;
      }
      const teamPayload = await getJson(
        `${apiBase}/my-brigade/teams/${team.teamId}/members`,
        authToken,
      );
      teamMemberMap.set(
        team.teamId,
        (teamPayload?.members ?? []).map((member) => normalizeMember(teamPayload.team ?? team, member)),
      );
    }
  }

  for (const team of teamsToSync) {
    const teamMembers = teamMemberMap.get(team.teamId) ?? [];
    members.push(...teamMembers);
    const scoreLogLimit = Math.min(appConfig.logLimit, SCORE_LOG_LIMIT_MAX);

    const memberLogRows = await mapWithConcurrency(teamMembers, appConfig.logConcurrency, async (member) => {
      const scoreLogUrl =
        team.isCurrentTeam || !useBrigadeMode
          ? `${apiBase}/my-team/members/${member.studentId}/score-logs?limit=${scoreLogLimit}`
          : `${apiBase}/my-brigade/teams/${team.teamId}/members/${member.studentId}/score-logs?limit=${scoreLogLimit}`;
      const logs = await getJson(scoreLogUrl, authToken);

      return (logs ?? []).map((log) => {
        const logicalDate = log.logged_at
          ? zonedDateKey(new Date(log.logged_at), appConfig.timezone, scoreResetHour)
          : "";
        return buildLogRow(log, member, fetchedAt, logicalDate);
      });
    });

    for (const rows of memberLogRows) {
      for (const row of rows) {
        if (!logIds.has(row.logId)) {
          logIds.add(row.logId);
          rawLogs.push(row);
        }
      }
    }
  }

  if (teamConfig.extraSelfMembers?.length) {
    const extraCollected = await collectExtraSelfMembersAndLogs(
      teamConfig,
      appConfig,
      schoolId,
      scoreResetHour,
      fetchedAt,
    );
    members.push(...extraCollected.members);
    notes.push(...extraCollected.notes);

    for (const row of extraCollected.rawLogs) {
      if (!logIds.has(row.logId)) {
        logIds.add(row.logId);
        rawLogs.push(row);
      }
    }
  }

  members.sort((a, b) => compareMembersForDisplay(a, b, { groupByTeam: useBrigadeMode }));
  adjustWeeklyLogicalDates(rawLogs);

  return {
    members,
    rawLogs,
    scoreResetHour,
    scope: notes.join(", "),
  };
}

function rowsFromObjects(headers, objects, mapper) {
  return [headers, ...objects.map(mapper)];
}

function rawLogKey(log) {
  return log.logId || `${log.memberId}::${log.questTitle}::${log.loggedAt}`;
}

function rawLogFromSheetRow(row) {
  if (!row?.[0] && !row?.[1] && !row?.[6] && !row?.[9]) {
    return null;
  }

  const log = {
    logId: row[0] ?? "",
    memberId: row[1] ?? "",
    studentId: row[2] ?? "",
    memberName: row[3] ?? "",
    teamId: row[4] ?? "",
    teamName: row[5] ?? "",
    questTitle: row[6] ?? "",
    sourceType: row[7] ?? "",
    points: Number(row[8] ?? 0),
    loggedAt: row[9] ?? "",
    logicalDate: row[10] ?? "",
    weeklyLogicalDate: row[10] ?? "",
    fetchedAt: row[11] ?? "",
  };
  return rawLogKey(log) ? log : null;
}

function mergeRawLogs(existingRows, newLogs) {
  const logsByKey = new Map();

  for (const row of existingRows.slice(1)) {
    const log = rawLogFromSheetRow(row);
    if (log) {
      logsByKey.set(rawLogKey(log), log);
    }
  }

  for (const log of newLogs) {
    logsByKey.set(rawLogKey(log), log);
  }

  const mergedLogs = [...logsByKey.values()].sort((a, b) => {
    const timeCompare = String(a.loggedAt).localeCompare(String(b.loggedAt));
    if (timeCompare !== 0) {
      return timeCompare;
    }
    return String(a.logId).localeCompare(String(b.logId));
  });

  return adjustWeeklyLogicalDates(mergedLogs);
}

async function loadTaskRules(sheetsClient) {
  const values = await sheetsClient.getValues("task_rules!A:H");
  if (values.length <= 1) {
    return [];
  }

  const [, ...rows] = values;
  return rows
    .filter((row) => row[0] || row[2] || row[5])
    .map((row) => ({
      ruleId: row[0] ?? "",
      active: String(row[1] ?? "").toUpperCase() === "TRUE",
      taskName: row[2] ?? "",
      period: (row[3] ?? "").toLowerCase(),
      matchType: (row[4] ?? "contains").toLowerCase(),
      matchValue: row[5] ?? "",
      requiredCount: Number(row[6] ?? 1),
      notes: row[7] ?? "",
    }))
    .filter((rule) => rule.active && rule.taskName && rule.matchValue);
}

function matchesRule(questTitle, rule) {
  if (!questTitle) {
    return false;
  }
  if (rule.matchType === "exact") {
    return questTitle === rule.matchValue;
  }
  return questTitle.includes(rule.matchValue);
}

function buildQuestCatalog(rawLogs) {
  const map = new Map();
  for (const log of rawLogs) {
    const existing = map.get(log.questTitle) ?? {
      questTitle: log.questTitle,
      timesSeen: 0,
      lastSeenAt: "",
      sampleMember: log.memberName,
      sampleTeam: log.teamName,
    };
    existing.timesSeen += 1;
    if (!existing.lastSeenAt || log.loggedAt > existing.lastSeenAt) {
      existing.lastSeenAt = log.loggedAt;
      existing.sampleMember = log.memberName;
      existing.sampleTeam = log.teamName;
    }
    map.set(log.questTitle, existing);
  }
  return [...map.values()].sort((a, b) => a.questTitle.localeCompare(b.questTitle, "zh-Hant"));
}

function weekDatesForDashboard(config, scoreResetHour) {
  const today = todayKey(config.timezone, scoreResetHour);
  const monday = weekStartKey(today, config.weekStart);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

function getCampaignWeekInfo(config, scoreResetHour) {
  const today = todayKey(config.timezone, scoreResetHour);
  const matchedWeek = CAMPAIGN_WEEKS.find((week) => week.start <= today && today <= week.end) ?? null;

  if (!matchedWeek) {
    const weekDates = weekDatesForDashboard(config, scoreResetHour);
    return {
      currentWeekLabel: "一般週",
      currentWeekStart: weekDates[0],
      currentWeekEnd: weekDates[6],
      weekDates,
      themeCycleLabel: "一般週",
      themeCycleStart: weekDates[0],
      themeCycleEnd: weekDates[6],
      themeQuestTitle: null,
    };
  }

  const weekDates = [];
  let cursor = matchedWeek.start;
  while (cursor <= matchedWeek.end) {
    weekDates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  while (weekDates.length < 7) {
    weekDates.push("");
  }

  const cycleWeeks = CAMPAIGN_WEEKS.filter((week) => week.cycle === matchedWeek.cycle);
  return {
    currentWeekLabel: matchedWeek.weekLabel,
    currentWeekStart: matchedWeek.start,
    currentWeekEnd: matchedWeek.end,
    weekDates,
    themeCycleLabel:
      cycleWeeks.length > 1
        ? `${cycleWeeks[0].weekLabel}~${cycleWeeks[cycleWeeks.length - 1].weekLabel}`
        : cycleWeeks[0].weekLabel,
    themeCycleStart: cycleWeeks[0].start,
    themeCycleEnd: cycleWeeks[cycleWeeks.length - 1].end,
    themeQuestTitle: `主題親證${matchedWeek.cycle}`,
  };
}

function countTaskMatches(logs, task) {
  const matchedLogs = logs.filter((log) => task.match(log.questTitle));
  if (task.countMode === "unique-month") {
    const monthKeys = new Set(
      matchedLogs.map((log) => {
        const dateKey = log.weeklyLogicalDate ?? log.logicalDate;
        return dateKey.slice(0, 7);
      }),
    );
    return monthKeys.size;
  }
  return matchedLogs.length;
}

function sumLogPoints(logs) {
  return logs.reduce((sum, log) => sum + Number(log.points ?? 0), 0);
}

function getCampaignScoreCells(member, allMemberLogs, campaign, scoreMode) {
  if (scoreMode === "history") {
    const weekPoints = sumLogPoints(
      allMemberLogs.filter(
        (log) =>
          (log.weeklyLogicalDate ?? log.logicalDate) >= campaign.currentWeekStart &&
          (log.weeklyLogicalDate ?? log.logicalDate) <= campaign.currentWeekEnd,
      ),
    );
    const totalPointsAtWeekEnd = sumLogPoints(
      allMemberLogs.filter((log) => (log.weeklyLogicalDate ?? log.logicalDate) <= campaign.currentWeekEnd),
    );
    return [totalPointsAtWeekEnd, weekPoints];
  }

  return [member.todayScore, member.weeklyScore, member.totalScore];
}

function stripCountSuffix(title) {
  return title.replace(/\s*\(\d+次\)$/, "");
}

function isDreamReleaseQuest(questTitle) {
  return questTitle.includes("解圓夢計畫") || questTitle.includes("解圓夢計劃");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesThemeProofQuest(questTitle, campaign) {
  if (!questTitle.includes("主題親證")) {
    return false;
  }
  if (!campaign.themeQuestTitle) {
    return true;
  }
  const normalizedQuestTitle = questTitle.replace(/\s+/g, "");
  const normalizedThemeTitle = campaign.themeQuestTitle.replace(/\s+/g, "");
  return new RegExp(`${escapeRegExp(normalizedThemeTitle)}(?!\\d)`).test(normalizedQuestTitle);
}

function buildWeeklyDashboardForCampaign(teamConfig, members, rawLogs, campaign, options = {}) {
  const isBrigadeView = teamConfig.roleType === "brigade";
  const scoreMode = options.scoreMode ?? "current";
  const leaderboardRanks = options.leaderboardRanks ?? { byId: new Map(), byName: new Map() };
  const includeLeaderboardRank = scoreMode !== "history";
  const headerRow =
    scoreMode === "history"
      ? isBrigadeView
        ? BRIGADE_WEEKLY_HISTORY_DASHBOARD_HEADERS
        : WEEKLY_HISTORY_DASHBOARD_HEADERS
      : isBrigadeView
        ? BRIGADE_WEEKLY_DASHBOARD_HEADERS
        : WEEKLY_DASHBOARD_HEADERS;
  const weekDates = campaign.weekDates;
  const monday = campaign.currentWeekStart;
  const sunday = campaign.currentWeekEnd;
  const logsByMember = new Map();

  for (const log of rawLogs) {
    if (!logsByMember.has(log.memberId)) {
      logsByMember.set(log.memberId, []);
    }
    logsByMember.get(log.memberId).push(log);
  }

  const dailyQuestOptions = [
    "當下之舞",
    "打拳",
    "每日五感恩",
    "一日一蔬食",
    "流動情緒(觀呼吸)",
    "感恩冥想",
    "亥/子時入睡",
  ];

  const taskMatchers = [
    {
      title: "圓夢計畫親證 (2次)",
      requiredCount: 2,
      match: (questTitle) => questTitle.includes("圓夢計") && !isDreamReleaseQuest(questTitle),
      displayPartialCount: true,
    },
    { title: "欣賞夥伴", requiredCount: 1, match: (questTitle) => questTitle === "欣賞夥伴" },
    {
      title: "主題親證",
      requiredCount: 1,
      match: (questTitle) => matchesThemeProofQuest(questTitle, campaign),
      allTime: true,
    },
    { title: "天使通話 (1次)", requiredCount: 1, match: (questTitle) => questTitle === "天使通話" },
    { title: "蓋婭的召喚 (1次)", requiredCount: 1, match: (questTitle) => questTitle === "蓋婭的召喚" },
    { title: "親證分享 (1次)", requiredCount: 1, match: (questTitle) => questTitle === "親證分享" },
    {
      title: "參加心成活動 (2次)",
      requiredCount: 2,
      match: (questTitle) => questTitle === "參加心成活動",
      displayPartialCount: true,
    },
    {
      title: "實體小組定聚 (2次)",
      requiredCount: 2,
      match: (questTitle) => questTitle.includes(stripCountSuffix("實體小組定聚 (2次)")),
      rangeStart: SPECIAL_EVENT_START,
      rangeEnd: campaign.currentWeekEnd,
      countMode: "unique-month",
      displayPartialCount: true,
    },
    {
      title: "巔峰取經試煉 (1次)",
      requiredCount: 1,
      match: (questTitle) => questTitle.includes(stripCountSuffix("巔峰取經試煉 (1次)")),
      allTime: true,
    },
    {
      title: "解圓夢計畫 (1次)",
      requiredCount: 1,
      match: isDreamReleaseQuest,
      allTime: true,
    },
    {
      title: "親證班課後課 (1次)",
      requiredCount: 1,
      match: (questTitle) => questTitle.includes(stripCountSuffix("親證班課後課 (1次)")),
      allTime: true,
    },
    {
      title: "參加結業典禮 (1次)",
      requiredCount: 1,
      match: (questTitle) => questTitle.includes(stripCountSuffix("參加結業典禮 (1次)")),
      allTime: true,
    },
    {
      title: "傳愛",
      match: (questTitle) => questTitle === "傳愛",
      allTime: true,
      displayCount: true,
    },
  ];

  const metaRows = [
    [
      "統計週期",
      `${campaign.currentWeekLabel} ${monday} ~ ${sunday}`,
      "手機同步",
      teamConfig.webAppUrl ? `=HYPERLINK("${teamConfig.webAppUrl}","手機點我同步")` : "",
    ],
    ["主題親證週期", `${campaign.themeCycleLabel} ${campaign.themeCycleStart} ~ ${campaign.themeCycleEnd}`],
    [
      "說明",
      "週一到週日欄位顯示當日每日任務完成數；3項以上打勾，未滿3項顯示完成數字。主題親證採兩週一輪，只認該輪指定主題親證，完成 1 次即打勾。實體小組定聚為 6 月、7 月各完成 1 次，總共 2 次即打勾。巔峰取經試煉、解圓夢計畫、親證班課後課、參加結業典禮為整個活動期間完成 1 次即打勾。傳愛顯示整個活動期間累計次數。",
    ],
    [],
    headerRow,
  ];

  const memberRows = [...members]
    .sort((a, b) => compareMembersForDisplay(a, b, { groupByTeam: isBrigadeView }))
    .map((member) => {
      const allMemberLogs = logsByMember.get(member.memberId) ?? [];
      const memberLogs = allMemberLogs.filter((log) => log.logicalDate >= monday && log.logicalDate <= sunday);
      const memberWeekLogs = allMemberLogs.filter(
        (log) => (log.weeklyLogicalDate ?? log.logicalDate) >= monday && (log.weeklyLogicalDate ?? log.logicalDate) <= sunday,
      );

      const dailyCounts = weekDates.map((dateKey) => {
        const dayLogs = memberLogs.filter((log) => log.logicalDate === dateKey);
        const completedOptions = new Set(
          dayLogs.map((log) => log.questTitle).filter((questTitle) => dailyQuestOptions.includes(questTitle)),
        );
        return completedOptions.size;
      });

      const dailyCells = dailyCounts.map((count) => (count >= 3 ? "✓" : String(count)));
      const weeklyTaskChecks = taskMatchers.map((task) => {
        const sourceLogs = task.allTime
          ? allMemberLogs
          : task.rangeStart
            ? allMemberLogs.filter(
                (log) =>
                  (log.weeklyLogicalDate ?? log.logicalDate) >= task.rangeStart &&
                  (log.weeklyLogicalDate ?? log.logicalDate) <= task.rangeEnd,
              )
            : memberWeekLogs;
        const matchCount = countTaskMatches(sourceLogs, task);
        if (task.displayCount) {
          return matchCount > 0 ? matchCount : "";
        }
        if (matchCount >= task.requiredCount) {
          return "✓";
        }
        if (task.displayPartialCount && matchCount > 0) {
          return String(matchCount);
        }
        return "";
      });

      const scoreCells = getCampaignScoreCells(member, allMemberLogs, campaign, scoreMode);
      const leaderboardRank = includeLeaderboardRank
        ? (leaderboardRanks.byId.get(member.memberId) ?? leaderboardRanks.byName.get(member.memberName) ?? "")
        : null;
      const dashboardScoreCells = includeLeaderboardRank ? [...scoreCells, leaderboardRank] : scoreCells;

      return isBrigadeView
        ? [member.teamName, member.memberName, ...dashboardScoreCells, ...dailyCells, ...weeklyTaskChecks]
        : [member.memberName, ...dashboardScoreCells, ...dailyCells, ...weeklyTaskChecks];
    });

  return [...metaRows, ...memberRows];
}

function buildWeeklyDashboard(teamConfig, appConfig, members, rawLogs, scoreResetHour, leaderboardRanks) {
  return buildWeeklyDashboardForCampaign(
    teamConfig,
    members,
    rawLogs,
    getCampaignWeekInfo(appConfig, scoreResetHour),
    { leaderboardRanks },
  );
}

function buildWeeklyHistorySection(teamConfig, members, rawLogs, campaign) {
  const weeklyDashboardRows = buildWeeklyDashboardForCampaign(teamConfig, members, rawLogs, campaign, {
    scoreMode: "history",
  });
  const headerRow = weeklyDashboardRows[4] ?? [];
  const memberRows = weeklyDashboardRows.slice(5);
  const sectionLabel = `${campaign.currentWeekLabel} ${campaign.currentWeekStart} ~ ${campaign.currentWeekEnd}`;
  return {
    sectionLabel,
    rows: [[sectionLabel], headerRow, ...memberRows, [], [], []],
  };
}

function buildWeeklyHistoryRows(teamConfig, appConfig, members, rawLogs, scoreResetHour) {
  const today = todayKey(appConfig.timezone, scoreResetHour);
  const campaigns = CAMPAIGN_WEEKS.filter((week) => week.start <= today);
  const rows = [];

  for (const week of campaigns) {
    const weekDates = [];
    let cursor = week.start;
    while (cursor <= week.end) {
      weekDates.push(cursor);
      cursor = addDays(cursor, 1);
    }
    while (weekDates.length < 7) {
      weekDates.push("");
    }

    const cycleWeeks = CAMPAIGN_WEEKS.filter((item) => item.cycle === week.cycle);
    const campaign = {
      currentWeekLabel: week.weekLabel,
      currentWeekStart: week.start,
      currentWeekEnd: week.end,
      weekDates,
      themeCycleLabel:
        cycleWeeks.length > 1
          ? `${cycleWeeks[0].weekLabel}~${cycleWeeks[cycleWeeks.length - 1].weekLabel}`
          : cycleWeeks[0].weekLabel,
      themeCycleStart: cycleWeeks[0].start,
      themeCycleEnd: cycleWeeks[cycleWeeks.length - 1].end,
      themeQuestTitle: `主題親證${week.cycle}`,
    };

    const section = buildWeeklyHistorySection(teamConfig, members, rawLogs, campaign);
    rows.push(...section.rows);
  }

  return rows;
}

function getWeeklyScoreColumnCount(headerRow, hasBrigadeColumn) {
  const firstScoreIndex = hasBrigadeColumn ? 2 : 1;
  const scoreLabels = new Set(["今日分數", "本週分數", "總分", "個人排名", "當週總分", "當週加分"]);
  let count = 0;
  while (scoreLabels.has(headerRow[firstScoreIndex + count])) {
    count += 1;
  }
  return count;
}

function pushWeeklyHeaderColorRequests(
  requests,
  sheetId,
  rowIndex,
  colCount,
  hasBrigadeColumn,
  scoreColumnCount = SCORE_COLUMN_COUNT,
) {
  const memberColumnIndex = hasBrigadeColumn ? 1 : 0;
  const scoreStartColumnIndex = memberColumnIndex + 1;
  const dailyStartColumnIndex = scoreStartColumnIndex + scoreColumnCount;
  const dailyEndColumnIndex = Math.min(dailyStartColumnIndex + DAILY_TASK_COLUMN_COUNT, colCount);
  const legacyWeeklyEndColumnIndex = Math.min(dailyEndColumnIndex + LEGACY_WEEKLY_TASK_COLUMN_COUNT, colCount);
  const newWeeklyStartColumnIndex = legacyWeeklyEndColumnIndex;

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: colCount,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.17, green: 0.34, blue: 0.55 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: "CENTER",
          verticalAlignment: "MIDDLE",
          wrapStrategy: "WRAP",
        },
      },
      fields:
        "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
    },
  });

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: dailyStartColumnIndex,
        endColumnIndex: dailyEndColumnIndex,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.26, green: 0.56, blue: 0.33 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
        },
      },
      fields: "userEnteredFormat(backgroundColor,textFormat)",
    },
  });

  if (newWeeklyStartColumnIndex < colCount) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: newWeeklyStartColumnIndex,
          endColumnIndex: colCount,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.82, green: 0.55, blue: 0.16 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    });
  }
}

async function applyWeeklyHistoryFormatting(sheetsClient, rows) {
  const sheet = await sheetsClient.getSheetByTitle("weekly_history");
  if (!sheet) {
    return;
  }

  const sheetId = sheet.properties.sheetId;
  const rowCount = rows.length;
  const colCount = Math.max(...rows.map((row) => row.length), 1);
  const existingRules = sheet.conditionalFormats?.length ?? 0;
  const requests = [
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: rowCount,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 1 },
            horizontalAlignment: "CENTER",
            textFormat: { fontSize: 10 },
          },
        },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)",
      },
    },
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 0, frozenColumnCount: 0 },
        },
        fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
      },
    },
  ];

  for (let index = existingRules - 1; index >= 0; index -= 1) {
    requests.push({
      deleteConditionalFormatRule: {
        sheetId,
        index,
      },
    });
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const firstCell = String(row?.[0] ?? "");
    if (firstCell.includes("週") && firstCell.includes("~")) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: rowIndex,
            endRowIndex: rowIndex + 1,
            startColumnIndex: 0,
            endColumnIndex: colCount,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.95, green: 0.91, blue: 0.8 },
              textFormat: { bold: true, fontSize: 11 },
              horizontalAlignment: "LEFT",
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
        },
      });
    }

    const secondCell = String(row?.[1] ?? "");
    if (firstCell === "隊員" || secondCell === "隊員") {
      const hasBrigadeColumn = secondCell === "隊員";
      pushWeeklyHeaderColorRequests(
        requests,
        sheetId,
        rowIndex,
        colCount,
        hasBrigadeColumn,
        getWeeklyScoreColumnCount(row, hasBrigadeColumn),
      );
    }
  }

  if (colCount > 0) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: 0,
          endIndex: 1,
        },
        properties: { pixelSize: 120 },
        fields: "pixelSize",
      },
    });
  }

  if (colCount > 1) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: 1,
          endIndex: 2,
        },
        properties: { pixelSize: 120 },
        fields: "pixelSize",
      },
    });
  }

  const firstHeaderRow = rows.find((row) => row?.[0] === "隊員" || row?.[1] === "隊員") ?? [];
  const hasBrigadeColumn = firstHeaderRow[1] === "隊員";
  const memberColumnCount = hasBrigadeColumn ? 2 : 1;
  const scoreStartColumnIndex = memberColumnCount;
  const scoreEndColumnIndex = Math.min(
    scoreStartColumnIndex + getWeeklyScoreColumnCount(firstHeaderRow, hasBrigadeColumn),
    colCount,
  );
  const dailyStartColumnIndex = scoreEndColumnIndex;
  const dailyEndColumnIndex = Math.min(dailyStartColumnIndex + DAILY_TASK_COLUMN_COUNT, colCount);

  if (scoreStartColumnIndex < scoreEndColumnIndex) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: scoreStartColumnIndex,
          endIndex: scoreEndColumnIndex,
        },
        properties: { pixelSize: 82 },
        fields: "pixelSize",
      },
    });
  }

  if (dailyStartColumnIndex < dailyEndColumnIndex) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: dailyStartColumnIndex,
          endIndex: dailyEndColumnIndex,
        },
        properties: { pixelSize: 72 },
        fields: "pixelSize",
      },
    });
  }

  requests.push({
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [
          {
            sheetId,
            startRowIndex: 0,
            endRowIndex: rowCount,
            startColumnIndex: 0,
            endColumnIndex: colCount,
          },
        ],
        booleanRule: {
          condition: {
            type: "TEXT_EQ",
            values: [{ userEnteredValue: "✓" }],
          },
          format: {
            backgroundColor: { red: 0.84, green: 0.93, blue: 0.82 },
            textFormat: {
              bold: true,
              foregroundColor: { red: 0.11, green: 0.36, blue: 0.16 },
            },
          },
        },
      },
    },
  });

  await sheetsClient.batchUpdate({ requests });
}

async function applyWeeklyDashboardFormatting(sheetsClient, rows) {
  const sheet = await sheetsClient.getSheetByTitle("weekly_dashboard");
  if (!sheet) {
    return;
  }

  const sheetId = sheet.properties.sheetId;
  const rowCount = rows.length;
  const colCount = Math.max(...rows.map((row) => row.length), 1);
  const existingRules = sheet.conditionalFormats?.length ?? 0;
  const headerRowIndex = 4;
  const hasBrigadeColumn = rows[headerRowIndex]?.[0] === "小組";
  const memberColumnCount = hasBrigadeColumn ? 2 : 1;
  const scoreStartColumnIndex = memberColumnCount;
  const scoreEndColumnIndex = Math.min(scoreStartColumnIndex + WEEKLY_DASHBOARD_SCORE_COLUMN_COUNT, colCount);
  const dailyStartColumnIndex = scoreEndColumnIndex;
  const dailyEndColumnIndex = Math.min(dailyStartColumnIndex + DAILY_TASK_COLUMN_COUNT, colCount);
  const legacyWeeklyStartColumnIndex = dailyEndColumnIndex;
  const legacyWeeklyEndColumnIndex = Math.min(
    legacyWeeklyStartColumnIndex + LEGACY_WEEKLY_TASK_COLUMN_COUNT,
    colCount,
  );
  const newWeeklyStartColumnIndex = legacyWeeklyEndColumnIndex;

  const requests = [
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: rowCount,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 1 },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            textFormat: { fontSize: 10 },
          },
        },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)",
      },
    },
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: {
            frozenRowCount: 5,
            frozenColumnCount: Math.min(memberColumnCount + WEEKLY_DASHBOARD_SCORE_COLUMN_COUNT, colCount),
          },
        },
        fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
      },
    },
  ];

  for (let index = existingRules - 1; index >= 0; index -= 1) {
    requests.push({
      deleteConditionalFormatRule: {
        sheetId,
        index,
      },
    });
  }

  pushWeeklyHeaderColorRequests(
    requests,
    sheetId,
    headerRowIndex,
    colCount,
    hasBrigadeColumn,
    WEEKLY_DASHBOARD_SCORE_COLUMN_COUNT,
  );

  for (let rowIndex = 0; rowIndex < Math.min(headerRowIndex, rowCount); rowIndex += 1) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.97, green: 0.96, blue: 0.92 },
            horizontalAlignment: rowIndex === 2 ? "LEFT" : "CENTER",
            wrapStrategy: "WRAP",
            textFormat: { fontSize: rowIndex === 0 ? 11 : 10, bold: rowIndex < 2 },
          },
        },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment,wrapStrategy,textFormat)",
      },
    });
  }

  requests.push(
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: 0,
          endIndex: memberColumnCount,
        },
        properties: { pixelSize: 110 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: dailyStartColumnIndex,
          endIndex: Math.min(dailyEndColumnIndex, colCount),
        },
        properties: { pixelSize: 72 },
        fields: "pixelSize",
      },
    },
  );

  if (scoreStartColumnIndex < scoreEndColumnIndex) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: scoreStartColumnIndex,
          endIndex: scoreEndColumnIndex,
        },
        properties: { pixelSize: 76 },
        fields: "pixelSize",
      },
    });
  }

  if (newWeeklyStartColumnIndex < colCount) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: newWeeklyStartColumnIndex,
          endIndex: colCount,
        },
        properties: { pixelSize: 120 },
        fields: "pixelSize",
      },
    });
  }

  requests.push({
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [
          {
            sheetId,
            startRowIndex: headerRowIndex + 1,
            endRowIndex: rowCount,
            startColumnIndex: 0,
            endColumnIndex: colCount,
          },
        ],
        booleanRule: {
          condition: {
            type: "TEXT_EQ",
            values: [{ userEnteredValue: "✓" }],
          },
          format: {
            backgroundColor: { red: 0.84, green: 0.93, blue: 0.82 },
            textFormat: {
              bold: true,
              foregroundColor: { red: 0.11, green: 0.36, blue: 0.16 },
            },
          },
        },
      },
    },
  });

  await sheetsClient.batchUpdate({ requests });
}

function aggregateStatus(rawLogs, members, rules, config, scoreResetHour) {
  const dateKeys = enumerateDateKeys(todayKey(config.timezone, scoreResetHour), config.lookbackDays);
  const groupedDaily = new Map();
  const groupedWeekly = new Map();

  for (const log of rawLogs) {
    const dailyKey = `${log.memberId}::${log.logicalDate}`;
    const dailyLogs = groupedDaily.get(dailyKey) ?? [];
    dailyLogs.push(log);
    groupedDaily.set(dailyKey, dailyLogs);

    const weekStart = weekStartKey(log.weeklyLogicalDate ?? log.logicalDate, config.weekStart);
    const weeklyKey = `${log.memberId}::${weekStart}`;
    const weeklyLogs = groupedWeekly.get(weeklyKey) ?? [];
    weeklyLogs.push(log);
    groupedWeekly.set(weeklyKey, weeklyLogs);
  }

  const dailyRows = [];
  const weeklyRows = [];
  const dailyRules = rules.filter((rule) => rule.period === "daily");
  const weeklyRules = rules.filter((rule) => rule.period === "weekly");

  for (const member of members) {
    for (const dateKey of dateKeys) {
      const logs = groupedDaily.get(`${member.memberId}::${dateKey}`) ?? [];
      for (const rule of dailyRules) {
        const matches = logs.filter((log) => matchesRule(log.questTitle, rule));
        dailyRows.push({
          date: dateKey,
          teamName: member.teamName,
          memberName: member.memberName,
          taskName: rule.taskName,
          requiredCount: rule.requiredCount,
          actualCount: matches.length,
          completed: matches.length >= rule.requiredCount,
          matchedQuests: [...new Set(matches.map((log) => log.questTitle))].join(" | "),
          lastCompletedAt: matches.length > 0 ? matches.map((log) => log.loggedAt).sort().at(-1) : "",
        });
      }
    }

    const weekStarts = [...new Set(dateKeys.map((dateKey) => weekStartKey(dateKey, config.weekStart)))];
    for (const startKey of weekStarts) {
      const logs = groupedWeekly.get(`${member.memberId}::${startKey}`) ?? [];
      const endKey = addDays(startKey, 6);
      for (const rule of weeklyRules) {
        const matches = logs.filter((log) => matchesRule(log.questTitle, rule));
        weeklyRows.push({
          weekStart: startKey,
          weekEnd: endKey,
          teamName: member.teamName,
          memberName: member.memberName,
          taskName: rule.taskName,
          requiredCount: rule.requiredCount,
          actualCount: matches.length,
          completed: matches.length >= rule.requiredCount,
          matchedQuests: [...new Set(matches.map((log) => log.questTitle))].join(" | "),
          lastCompletedAt: matches.length > 0 ? matches.map((log) => log.loggedAt).sort().at(-1) : "",
        });
      }
    }
  }

  return { dailyRows, weeklyRows };
}

async function seedTaskRuleSheetIfEmpty(sheetsClient) {
  const values = await sheetsClient.getValues("task_rules!A:H");
  if (values.length > 0) {
    return;
  }
  await sheetsClient.writeSheet("task_rules", [
    TASK_RULE_HEADERS,
    ["example-daily", "FALSE", "示例每日任務", "daily", "contains", "晨間", "1", "把 FALSE 改成 TRUE 後才會納入統計"],
    ["example-weekly", "FALSE", "示例每週任務", "weekly", "exact", "週分享", "1", ""],
  ]);
}

async function writeAllSheets(sheetsClient, payload) {
  const {
    members,
    rawLogs,
    questCatalog,
    dailyRows,
    weeklyRows,
    weeklyDashboardRows,
    weeklyHistoryRows,
    scope,
    scoreResetHour,
    timezone,
    skipFormatting,
  } = payload;
  const syncedAt = formatDateTime(new Date(), timezone);

  await sheetsClient.ensureSheets(SHEET_NAMES);
  await seedTaskRuleSheetIfEmpty(sheetsClient);

  const existingRunLog = await sheetsClient.getValues("run_log!A:G");
  const previousRows = existingRunLog.length > 1 ? existingRunLog.slice(1) : [];

  await sheetsClient.writeSheets({
    members: rowsFromObjects(MEMBER_HEADERS, members, (member) => [
      member.teamId,
      member.teamName,
      member.memberId,
      member.studentId,
      member.memberName,
      member.identityName,
      boolCell(member.isTeamCaptain),
      boolCell(member.isBrigadeCaptain),
      member.todayScore,
      member.weeklyScore,
      member.totalScore,
    ]),
    raw_logs: rowsFromObjects(RAW_LOG_HEADERS, rawLogs, (log) => [
      log.logId,
      log.memberId,
      log.studentId,
      log.memberName,
      log.teamId,
      log.teamName,
      log.questTitle,
      log.sourceType,
      log.points,
      log.loggedAt,
      log.logicalDate,
      log.fetchedAt,
    ]),
    quest_catalog: rowsFromObjects(QUEST_CATALOG_HEADERS, questCatalog, (item) => [
      item.questTitle,
      item.timesSeen,
      item.lastSeenAt,
      item.sampleMember,
      item.sampleTeam,
    ]),
    daily_status: rowsFromObjects(DAILY_HEADERS, dailyRows, (row) => [
      row.date,
      row.teamName,
      row.memberName,
      row.taskName,
      row.requiredCount,
      row.actualCount,
      boolCell(row.completed),
      row.matchedQuests,
      row.lastCompletedAt,
    ]),
    weekly_status: rowsFromObjects(WEEKLY_HEADERS, weeklyRows, (row) => [
      row.weekStart,
      row.weekEnd,
      row.teamName,
      row.memberName,
      row.taskName,
      row.requiredCount,
      row.actualCount,
      boolCell(row.completed),
      row.matchedQuests,
      row.lastCompletedAt,
    ]),
    weekly_dashboard: weeklyDashboardRows,
    weekly_history: weeklyHistoryRows,
    run_log: [
      RUN_LOG_HEADERS,
      [
        syncedAt,
        scope,
        members.length,
        rawLogs.length,
        dailyRows.length,
        weeklyRows.length,
        `score reset hour=${scoreResetHour}`,
      ],
      ...previousRows.slice(0, 49),
    ],
  });

  if (skipFormatting) {
    console.log("FORTUNE_SKIP_FORMATTING is enabled; weekly dashboard/history formatting was skipped.");
    return;
  }
  await applyWeeklyDashboardFormatting(sheetsClient, weeklyDashboardRows);
  await applyWeeklyHistoryFormatting(sheetsClient, weeklyHistoryRows);
}

async function syncTeam(appConfig, teamConfig, leaderboardCache) {
  console.log(`[${teamConfig.teamKey}] Starting sync...`);
  const storageStatePath = requireStorageState(teamConfig.storageStatePath);
  const authToken = readAccessTokenFromStorageState(storageStatePath);
  const schoolId = teamConfig.schoolId || (await resolveSchoolId(teamConfig, authToken));
  console.log(`[${teamConfig.teamKey}] Collecting members and logs...`);
  const collected = await collectMembersAndLogs(teamConfig, appConfig, schoolId, authToken);
  if (collected.members.length === 0) {
    throw new Error(`[${teamConfig.teamKey}] Refusing to overwrite Google Sheets with 0 members. Refresh auth first.`);
  }

  let leaderboardRanks = { byId: new Map(), byName: new Map() };
  try {
    const leaderboardResult = await getCachedIndividualLeaderboardRanks(leaderboardCache, teamConfig, schoolId, authToken);
    leaderboardRanks = leaderboardResult.ranks;
    const action = leaderboardResult.fromCache ? "Reused cached" : "Loaded";
    console.log(`[${teamConfig.teamKey}] ${action} ${leaderboardRanks.byId.size} individual leaderboard ranks.`);
  } catch (error) {
    console.warn(`[${teamConfig.teamKey}] Could not load individual leaderboard ranks: ${error.message}`);
  }

  const sheetsClient = new GoogleSheetsClient({
    ...appConfig.google,
    spreadsheetId: teamConfig.sheetId,
  });
  await sheetsClient.ensureSheets(SHEET_NAMES);
  const existingRawLogRows = await sheetsClient.getValues("raw_logs!A:L");
  const mergedRawLogs = mergeRawLogs(existingRawLogRows, collected.rawLogs);
  console.log(
    `[${teamConfig.teamKey}] Merged raw logs: ${existingRawLogRows.length > 1 ? existingRawLogRows.length - 1 : 0} existing + ${
      collected.rawLogs.length
    } fetched => ${mergedRawLogs.length} total.`,
  );

  const taskRules = await loadTaskRules(sheetsClient);
  const questCatalog = buildQuestCatalog(mergedRawLogs);
  const { dailyRows, weeklyRows } = aggregateStatus(
    mergedRawLogs,
    collected.members,
    taskRules,
    appConfig,
    collected.scoreResetHour,
  );
  const weeklyDashboardRows = buildWeeklyDashboard(
    teamConfig,
    appConfig,
    collected.members,
    mergedRawLogs,
    collected.scoreResetHour,
    leaderboardRanks,
  );
  const weeklyHistoryRows = buildWeeklyHistoryRows(
    teamConfig,
    appConfig,
    collected.members,
    mergedRawLogs,
    collected.scoreResetHour,
  );

  console.log(`[${teamConfig.teamKey}] Writing Google Sheets...`);
  await writeAllSheets(sheetsClient, {
    ...collected,
    rawLogs: mergedRawLogs,
    questCatalog,
    dailyRows,
    weeklyRows,
    weeklyDashboardRows,
    weeklyHistoryRows,
    timezone: appConfig.timezone,
    skipFormatting: appConfig.skipFormatting,
  });

  console.log(`[${teamConfig.teamKey}] Synced ${collected.members.length} members and ${collected.rawLogs.length} logs.`);
}

async function main() {
  const appConfig = loadConfig();
  const leaderboardCache = new Map();
  const teamsToSync =
    appConfig.syncTeamKeys.length > 0
      ? appConfig.teams.filter((teamConfig) => appConfig.syncTeamKeys.includes(teamConfig.teamKey))
      : appConfig.teams;

  if (teamsToSync.length === 0) {
    throw new Error(`No enabled teams match FORTUNE_SYNC_TEAM_KEYS=${appConfig.syncTeamKeys.join(",")}`);
  }

  if (appConfig.syncTeamKeys.length > 0) {
    console.log(`Filtering sync to teams: ${teamsToSync.map((teamConfig) => teamConfig.teamKey).join(", ")}`);
  }

  for (const teamConfig of teamsToSync) {
    await syncTeam(appConfig, teamConfig, leaderboardCache);
  }
}

await main();
