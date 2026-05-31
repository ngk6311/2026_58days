import crypto from "node:crypto";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toA1Column(colNumber) {
  let value = colNumber;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export class GoogleSheetsClient {
  constructor({ clientEmail, privateKey, tokenUri, scope, spreadsheetId }) {
    this.clientEmail = clientEmail;
    this.privateKey = privateKey;
    this.tokenUri = tokenUri;
    this.scope = scope;
    this.spreadsheetId = spreadsheetId;
    this.cachedToken = null;
  }

  async getAccessToken() {
    const now = Math.floor(Date.now() / 1000);

    if (this.cachedToken && this.cachedToken.expiresAt > now + 60) {
      return this.cachedToken.accessToken;
    }

    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: this.clientEmail,
      scope: this.scope,
      aud: this.tokenUri,
      exp: now + 3600,
      iat: now,
    };

    const encodedHeader = base64Url(JSON.stringify(header));
    const encodedPayload = base64Url(JSON.stringify(payload));
    const signatureInput = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto
      .createSign("RSA-SHA256")
      .update(signatureInput)
      .sign(this.privateKey, "base64url");

    const assertion = `${signatureInput}.${signature}`;

    const response = await fetch(this.tokenUri, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get Google access token: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: now + Number(data.expires_in ?? 3600),
    };

    return this.cachedToken.accessToken;
  }

  async api(path, { method = "GET", query, body } = {}) {
    return this.withRetry(async () => {
      const token = await this.getAccessToken();
      const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}${path}`);

      if (query) {
        for (const [key, value] of Object.entries(query)) {
          url.searchParams.set(key, String(value));
        }
      }

      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const text = await response.text();
        throw this.buildApiError("Google Sheets API error", response.status, text);
      }

      if (response.status === 204) {
        return null;
      }

      return response.json();
    });
  }

  async getSpreadsheet() {
    return this.api("", { query: { includeGridData: false } });
  }

  async getSheetByTitle(title) {
    const spreadsheet = await this.getSpreadsheet();
    return spreadsheet.sheets.find((sheet) => sheet.properties.title === title) ?? null;
  }

  async ensureSheets(sheetTitles) {
    const spreadsheet = await this.getSpreadsheet();
    const existing = new Set(spreadsheet.sheets.map((sheet) => sheet.properties.title));
    const requests = [];

    for (const title of sheetTitles) {
      if (!existing.has(title)) {
        requests.push({ addSheet: { properties: { title } } });
      }
    }

    if (requests.length > 0) {
      await this.batchUpdate({ requests });
    }
  }

  async batchUpdate(body) {
    return this.api(":batchUpdate", { method: "POST", body });
  }

  buildApiError(prefix, status, text) {
    const error = new Error(`${prefix}: ${status} ${text}`);
    error.status = status;
    error.body = text;
    return error;
  }

  async withRetry(fn, maxAttempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const status = error?.status ?? 0;
        const retriable = status === 429 || status >= 500;
        if (!retriable || attempt === maxAttempts) {
          throw error;
        }

        const delayMs = status === 429 ? 65000 : 1000 * 2 ** (attempt - 1);
        console.log(
          `[GoogleSheets] ${status} on attempt ${attempt}/${maxAttempts}, retrying in ${Math.round(
            delayMs / 1000,
          )}s...`,
        );
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  async clearValues(range) {
    return this.withRetry(async () => {
      const token = await this.getAccessToken();
      const encodedRange = encodeURIComponent(range);
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values/${encodedRange}:clear`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const text = await response.text();
        throw this.buildApiError("Google Sheets clear error", response.status, text);
      }
    });
  }

  async clearValuesBatch(ranges) {
    if (ranges.length === 0) {
      return null;
    }
    return this.api("/values:batchClear", {
      method: "POST",
      body: { ranges },
    });
  }

  async updateValues(range, values) {
    return this.api(`/values/${encodeURIComponent(range)}`, {
      method: "PUT",
      query: { valueInputOption: "RAW" },
      body: {
        range,
        majorDimension: "ROWS",
        values,
      },
    });
  }

  async updateValuesBatch(data) {
    if (data.length === 0) {
      return null;
    }
    return this.api("/values:batchUpdate", {
      method: "POST",
      query: { valueInputOption: "RAW" },
      body: {
        valueInputOption: "RAW",
        data: data.map((item) => ({
          range: item.range,
          majorDimension: "ROWS",
          values: item.values,
        })),
      },
    });
  }

  async getValues(range) {
    const result = await this.api(`/values/${encodeURIComponent(range)}`);
    return result.values ?? [];
  }

  async writeSheet(title, rows) {
    const colCount = Math.max(...rows.map((row) => row.length), 1);
    const lastColumn = toA1Column(colCount);
    const range = `${title}!A1:${lastColumn}${rows.length}`;
    await this.clearValues(title);
    await this.updateValues(range, rows);
  }

  async writeSheets(entries) {
    const clearRanges = [];
    const data = [];

    for (const [title, rows] of Object.entries(entries)) {
      const safeRows = rows.length > 0 ? rows : [[]];
      const colCount = Math.max(...safeRows.map((row) => row.length), 1);
      const lastColumn = toA1Column(colCount);
      const range = `${title}!A1:${lastColumn}${safeRows.length}`;
      clearRanges.push(title);
      data.push({ range, values: safeRows });
    }

    await this.clearValuesBatch(clearRanges);
    await this.updateValuesBatch(data);
  }
}
