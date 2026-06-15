import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(".env");
const TEAMS_CONFIG_PATH = path.resolve("teams.json");
const TEAMS_LOCAL_CONFIG_PATH = path.resolve("teams.local.json");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const text = fs.readFileSync(filePath, "utf8");
  const result = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value.replace(/\\n/g, "\n");
  }

  return result;
}

const fileEnv = parseEnvFile(ENV_PATH);

function getEnv(key, fallback = undefined) {
  return process.env[key] ?? fileEnv[key] ?? fallback;
}

function requireEnv(key) {
  const value = getEnv(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getPositiveIntEnv(key, fallback) {
  const raw = getEnv(key, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function getBooleanEnv(key, fallback = false) {
  const raw = getEnv(key);
  if (raw === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(String(raw).trim().toLowerCase());
}

function loadGoogleCredentials() {
  const credentialsPath = getEnv("GOOGLE_CREDENTIALS_PATH", "./credentials.json");
  const resolvedPath = path.resolve(credentialsPath);

  if (fs.existsSync(resolvedPath)) {
    const raw = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    if (!raw.client_email || !raw.private_key) {
      throw new Error(`Invalid Google credentials JSON: ${resolvedPath}`);
    }

    return {
      source: resolvedPath,
      clientEmail: raw.client_email,
      privateKey: raw.private_key,
      tokenUri: raw.token_uri || "https://oauth2.googleapis.com/token",
    };
  }

  return {
    source: "env",
    clientEmail: requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    privateKey: requireEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"),
    tokenUri: "https://oauth2.googleapis.com/token",
  };
}

function loadBaseConfig() {
  const googleCredentials = loadGoogleCredentials();

  return {
    defaultPartnersUrl: getEnv(
      "FORTUNE_PARTNERS_URL",
      "https://www.bigsmileunity.com/bigsmile/fortune-game/partners",
    ),
    defaultSchoolId: getEnv("FORTUNE_SCHOOL_ID", ""),
    defaultApiBaseUrl: getEnv("FORTUNE_API_BASE_URL", "https://sincheng-api.playworld.com.tw"),
    defaultWebAppUrl: getEnv("FORTUNE_WEB_APP_URL", ""),
    timezone: getEnv("FORTUNE_TIMEZONE", "Asia/Taipei"),
    scoreResetHour: Number(getEnv("FORTUNE_SCORE_RESET_HOUR", "0")),
    weekStart: Number(getEnv("FORTUNE_WEEK_START", "1")),
    logLimit: getPositiveIntEnv("FORTUNE_LOG_LIMIT", 1000),
    logConcurrency: getPositiveIntEnv("FORTUNE_LOG_CONCURRENCY", 8),
    lookbackDays: getPositiveIntEnv("FORTUNE_LOOKBACK_DAYS", 28),
    skipFormatting: getBooleanEnv("FORTUNE_SKIP_FORMATTING", false),
    google: {
      clientEmail: googleCredentials.clientEmail,
      privateKey: googleCredentials.privateKey,
      tokenUri: googleCredentials.tokenUri,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      source: googleCredentials.source,
    },
  };
}

function parseJsonArrayFile(filePath, description) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`${description} must be an array.`);
  }
  return raw;
}

function parseJsonArrayString(rawText, description) {
  const raw = JSON.parse(rawText);
  if (!Array.isArray(raw)) {
    throw new Error(`${description} must be an array.`);
  }
  return raw;
}

function getTeamKey(raw) {
  return raw?.team_key || raw?.teamKey || null;
}

function mergeTeamConfigs(baseItems, overrideItems) {
  const merged = [...baseItems];
  const indexByKey = new Map();

  for (let index = 0; index < merged.length; index += 1) {
    const teamKey = getTeamKey(merged[index]);
    if (teamKey) {
      indexByKey.set(teamKey, index);
    }
  }

  for (const item of overrideItems) {
    const teamKey = getTeamKey(item);
    if (!teamKey) {
      throw new Error("Each team config must include team_key.");
    }

    if (indexByKey.has(teamKey)) {
      const existingIndex = indexByKey.get(teamKey);
      merged[existingIndex] = { ...merged[existingIndex], ...item };
    } else {
      indexByKey.set(teamKey, merged.length);
      merged.push(item);
    }
  }

  return merged;
}

function normalizeTeamConfig(raw, baseConfig) {
  const teamKey = raw.team_key || raw.teamKey;
  const sheetId = raw.sheet_id || raw.sheetId;
  const roleType = (raw.role_type || raw.roleType || "team").toLowerCase();

  if (!teamKey) {
    throw new Error("Each team config must include team_key.");
  }
  if (!sheetId) {
    throw new Error(
      `Team ${teamKey} is missing sheet_id. Add it in teams.local.json or provide a TEAMS_CONFIG_JSON override.`,
    );
  }
  if (!["team", "brigade"].includes(roleType)) {
    throw new Error(`Team ${teamKey} has invalid role_type: ${roleType}`);
  }

  return {
    teamKey,
    teamName: raw.team_name || raw.teamName || teamKey,
    roleType,
    sheetId,
    partnersUrl: raw.partners_url || raw.partnersUrl || baseConfig.defaultPartnersUrl,
    schoolId: raw.school_id || raw.schoolId || baseConfig.defaultSchoolId,
    apiBaseUrl: raw.api_base_url || raw.apiBaseUrl || baseConfig.defaultApiBaseUrl,
    webAppUrl: raw.web_app_url || raw.webAppUrl || baseConfig.defaultWebAppUrl,
    storageStatePath:
      raw.storage_state_path || raw.storageStatePath || `.auth/${teamKey}-storage-state.json`,
    enabled: raw.enabled !== false,
  };
}

function loadTeamsConfig(baseConfig) {
  let rawTeams = [];

  if (fs.existsSync(TEAMS_CONFIG_PATH)) {
    rawTeams = parseJsonArrayFile(TEAMS_CONFIG_PATH, "teams.json");
  }

  if (fs.existsSync(TEAMS_LOCAL_CONFIG_PATH)) {
    rawTeams = mergeTeamConfigs(rawTeams, parseJsonArrayFile(TEAMS_LOCAL_CONFIG_PATH, "teams.local.json"));
  }

  const teamsConfigJson = getEnv("TEAMS_CONFIG_JSON", "");
  if (teamsConfigJson) {
    rawTeams = mergeTeamConfigs(rawTeams, parseJsonArrayString(teamsConfigJson, "TEAMS_CONFIG_JSON"));
  }

  if (rawTeams.length > 0) {
    return rawTeams.map((item) => normalizeTeamConfig(item, baseConfig)).filter((item) => item.enabled);
  }

  return [
    normalizeTeamConfig(
      {
        team_key: "default",
        team_name: "default",
        role_type: "team",
        sheet_id: requireEnv("FORTUNE_SHEET_ID"),
        partners_url: baseConfig.defaultPartnersUrl,
        school_id: baseConfig.defaultSchoolId,
        api_base_url: baseConfig.defaultApiBaseUrl,
        web_app_url: baseConfig.defaultWebAppUrl,
        storage_state_path: ".auth/storage-state.json",
      },
      baseConfig,
    ),
  ];
}

export function loadConfig() {
  const baseConfig = loadBaseConfig();
  return {
    ...baseConfig,
    teams: loadTeamsConfig(baseConfig),
  };
}
