import fs from "node:fs";
import path from "node:path";
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
];

const BRIGADE_WEEKLY_DASHBOARD_HEADERS = ["小組", ...WEEKLY_DASHBOARD_HEADERS];

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

async function resolveSchoolId(teamConfig, authToken) {
  const schoolSlug = parseSchoolSlugFromPartnersUrl(teamConfig.partnersUrl);
  if (!schoolSlug) {
    throw new Error(`Could not resolve school slug from ${teamConfig.partnersUrl}`);
  }

  const url = `${teamConfig.apiBaseUrl}/api/v1/public/schoolsInfo/${schoolSlug}`;
  const response = await fetch(url, {
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
  const response = await fetch(url, {
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
  const response = await fetch(url, {
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

function isMondayDateKey(dateKey) {
  if (!dateKey) {
    return false;
  }
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay() === 1;
}

function adjustWeeklyLogicalDates(rawLogs) {
  const targetQuest = "親證分享";
  const grouped = new Map();

  for (const log of rawLogs) {
    log.weeklyLogicalDate = log.logicalDate;
    if (log.questTitle !== targetQuest || !isMondayDateKey(log.logicalDate)) {
      continue;
    }

    const key = `${log.memberId}::${log.logicalDate}`;
    const logs = grouped.get(key) ?? [];
    logs.push(log);
    grouped.set(key, logs);
  }

  for (const [key, logs] of grouped.entries()) {
    logs.sort((a, b) => String(a.loggedAt).localeCompare(String(b.loggedAt)));
    const [, mondayDate] = key.split("::");
    if (logs.length > 0) {
      logs[0].weeklyLogicalDate = addDays(mondayDate, -1);
    }
  }

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
  if (useBrigadeMode) {
    for (const team of brigadeData?.teams ?? []) {
      teamsToSync.push({
        teamId: team.team_id,
        teamName: team.team_name,
        isCurrentTeam: !expectsBrigadeRole && currentTeamId ? team.team_id === currentTeamId : false,
      });
    }
  } else if (teamData?.team) {
    teamsToSync.push({
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

    for (const member of teamMembers) {
      const scoreLogUrl =
        team.isCurrentTeam || !useBrigadeMode
          ? `${apiBase}/my-team/members/${member.studentId}/score-logs?limit=${appConfig.logLimit}`
          : `${apiBase}/my-brigade/teams/${team.teamId}/members/${member.studentId}/score-logs?limit=${appConfig.logLimit}`;
      const logs = await getJson(scoreLogUrl, authToken);

      for (const log of logs ?? []) {
        const logicalDate = log.logged_at
          ? zonedDateKey(new Date(log.logged_at), appConfig.timezone, scoreResetHour)
          : "";
        const row = buildLogRow(log, member, fetchedAt, logicalDate);
        if (!logIds.has(row.logId)) {
          logIds.add(row.logId);
          rawLogs.push(row);
        }
      }
    }
  }

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
  };
}

function buildWeeklyDashboardForCampaign(teamConfig, members, rawLogs, campaign) {
  const isBrigadeView = teamConfig.roleType === "brigade";
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
      match: (questTitle) => questTitle.includes("圓夢計"),
      displayPartialCount: true,
    },
    { title: "欣賞夥伴", requiredCount: 1, match: (questTitle) => questTitle === "欣賞夥伴" },
    {
      title: "主題親證",
      requiredCount: 1,
      match: (questTitle) => questTitle.includes("主題親證"),
      rangeStart: campaign.themeCycleStart,
      rangeEnd: campaign.themeCycleEnd,
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
  ];

  const metaRows = [
    [
      "統計週期",
      `${campaign.currentWeekLabel} ${monday} ~ ${sunday}`,
      "手機同步",
      teamConfig.webAppUrl ? `=HYPERLINK("${teamConfig.webAppUrl}","手機點我同步")` : "",
    ],
    ["主題親證週期", `${campaign.themeCycleLabel} ${campaign.themeCycleStart} ~ ${campaign.themeCycleEnd}`],
    ["說明", "週一到週日欄位顯示當日每日任務完成數；3項以上打勾，未滿3項顯示完成數字。主題親證採兩週一輪，該輪完成 1 次即打勾。"],
    [],
    isBrigadeView ? BRIGADE_WEEKLY_DASHBOARD_HEADERS : WEEKLY_DASHBOARD_HEADERS,
  ];

  const memberRows = [...members]
    .sort((a, b) => {
      if (isBrigadeView) {
        const teamCompare = a.teamName.localeCompare(b.teamName, "zh-Hant");
        if (teamCompare !== 0) {
          return teamCompare;
        }
      }
      if (a.isTeamCaptain !== b.isTeamCaptain) {
        return a.isTeamCaptain ? -1 : 1;
      }
      return a.memberName.localeCompare(b.memberName, "zh-Hant");
    })
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
        const sourceLogs = task.rangeStart
          ? allMemberLogs.filter(
              (log) =>
                (log.weeklyLogicalDate ?? log.logicalDate) >= task.rangeStart &&
                (log.weeklyLogicalDate ?? log.logicalDate) <= task.rangeEnd,
            )
          : memberWeekLogs;
        const matchCount = sourceLogs.filter((log) => task.match(log.questTitle)).length;
        if (matchCount >= task.requiredCount) {
          return "✓";
        }
        if (task.displayPartialCount && matchCount > 0) {
          return String(matchCount);
        }
        return "";
      });

      return isBrigadeView
        ? [member.teamName, member.memberName, ...dailyCells, ...weeklyTaskChecks]
        : [member.memberName, ...dailyCells, ...weeklyTaskChecks];
    });

  return [...metaRows, ...memberRows];
}

function buildWeeklyDashboard(teamConfig, appConfig, members, rawLogs, scoreResetHour) {
  return buildWeeklyDashboardForCampaign(
    teamConfig,
    members,
    rawLogs,
    getCampaignWeekInfo(appConfig, scoreResetHour),
  );
}

function buildWeeklyHistorySection(teamConfig, members, rawLogs, campaign) {
  const weeklyDashboardRows = buildWeeklyDashboardForCampaign(teamConfig, members, rawLogs, campaign);
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
    };

    const section = buildWeeklyHistorySection(teamConfig, members, rawLogs, campaign);
    rows.push(...section.rows);
  }

  return rows;
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
              backgroundColor: { red: 0.15, green: 0.38, blue: 0.22 },
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              horizontalAlignment: "CENTER",
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
        },
      });
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

  await applyWeeklyHistoryFormatting(sheetsClient, weeklyHistoryRows);
}

async function syncTeam(appConfig, teamConfig) {
  console.log(`[${teamConfig.teamKey}] Starting sync...`);
  const storageStatePath = requireStorageState(teamConfig.storageStatePath);
  const authToken = readAccessTokenFromStorageState(storageStatePath);
  const schoolId = teamConfig.schoolId || (await resolveSchoolId(teamConfig, authToken));
  console.log(`[${teamConfig.teamKey}] Collecting members and logs...`);
  const collected = await collectMembersAndLogs(teamConfig, appConfig, schoolId, authToken);

  const sheetsClient = new GoogleSheetsClient({
    ...appConfig.google,
    spreadsheetId: teamConfig.sheetId,
  });

  const taskRules = await loadTaskRules(sheetsClient);
  const questCatalog = buildQuestCatalog(collected.rawLogs);
  const { dailyRows, weeklyRows } = aggregateStatus(
    collected.rawLogs,
    collected.members,
    taskRules,
    appConfig,
    collected.scoreResetHour,
  );
  const weeklyDashboardRows = buildWeeklyDashboard(
    teamConfig,
    appConfig,
    collected.members,
    collected.rawLogs,
    collected.scoreResetHour,
  );
  const weeklyHistoryRows = buildWeeklyHistoryRows(
    teamConfig,
    appConfig,
    collected.members,
    collected.rawLogs,
    collected.scoreResetHour,
  );

  console.log(`[${teamConfig.teamKey}] Writing Google Sheets...`);
  await writeAllSheets(sheetsClient, {
    ...collected,
    questCatalog,
    dailyRows,
    weeklyRows,
    weeklyDashboardRows,
    weeklyHistoryRows,
    timezone: appConfig.timezone,
  });

  console.log(`[${teamConfig.teamKey}] Synced ${collected.members.length} members and ${collected.rawLogs.length} logs.`);
}

async function main() {
  const appConfig = loadConfig();
  for (const teamConfig of appConfig.teams) {
    await syncTeam(appConfig, teamConfig);
  }
}

await main();
