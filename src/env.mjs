import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(".env");

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
      (value.startsWith("\"") && value.endsWith("\"")) ||
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

export function loadConfig() {
  const partnersUrl = getEnv(
    "FORTUNE_PARTNERS_URL",
    "https://www.bigsmileunity.com/bigsmile/fortune-game/partners",
  );
  const googleCredentials = loadGoogleCredentials();

  return {
    partnersUrl,
    sheetId: requireEnv("FORTUNE_SHEET_ID"),
    schoolId: getEnv("FORTUNE_SCHOOL_ID", ""),
    apiBaseUrl: getEnv("FORTUNE_API_BASE_URL", "https://sincheng-api.playworld.com.tw"),
    timezone: getEnv("FORTUNE_TIMEZONE", "Asia/Taipei"),
    scoreResetHour: Number(getEnv("FORTUNE_SCORE_RESET_HOUR", "0")),
    weekStart: Number(getEnv("FORTUNE_WEEK_START", "1")),
    logLimit: Number(getEnv("FORTUNE_LOG_LIMIT", "100")),
    lookbackDays: Number(getEnv("FORTUNE_LOOKBACK_DAYS", "28")),
    google: {
      clientEmail: googleCredentials.clientEmail,
      privateKey: googleCredentials.privateKey,
      tokenUri: googleCredentials.tokenUri,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      source: googleCredentials.source,
    },
  };
}
