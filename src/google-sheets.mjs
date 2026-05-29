import crypto from "node:crypto";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
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
      throw new Error(`Google Sheets API error: ${response.status} ${await response.text()}`);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async getSpreadsheet() {
    return this.api("", { query: { includeGridData: false } });
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

  async clearValues(range) {
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
      throw new Error(`Google Sheets clear error: ${response.status} ${await response.text()}`);
    }
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
}
