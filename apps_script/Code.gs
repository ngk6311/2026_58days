function getSyncOptions_() {
  const properties = PropertiesService.getScriptProperties();
  return {
    teamKeys: properties.getProperty('SYNC_TEAM_KEYS') || '',
    skipFormatting: properties.getProperty('SKIP_FORMATTING') || 'false',
  };
}

function runWorkflow_(workflowId, options) {
  const owner = 'ngk6311';
  const repo = '2026_58days';
  const branch = 'main';
  const statusSheetName = 'weekly_dashboard';
  const statusCell = 'A1';

  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error('Missing GITHUB_TOKEN in Script Properties');
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(statusSheetName);
  if (sheet) {
    sheet.getRange(statusCell).setValue('Sync requested...');
  }

  const payload = { ref: branch };
  if (options && options.inputs) {
    payload.inputs = options.inputs;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code >= 200 && code < 300) {
    if (sheet) {
      sheet.getRange(statusCell).setValue(`Workflow triggered: ${workflowId}`);
    }
    return { ok: true, workflow: workflowId };
  }

  if (sheet) {
    sheet.getRange(statusCell).setValue(`Workflow trigger failed: ${code}`);
  }
  throw new Error(`GitHub trigger failed: ${code}\n${body}`);
}

function runSync_() {
  return runWorkflow_('sync-fortune-game.yml');
}

function runLeaderboardSync_() {
  return runWorkflow_('sync-lobby-leaderboard.yml');
}

function triggerSync() {
  runSync_();
  SpreadsheetApp.getActiveSpreadsheet().toast('Main sync requested.', 'Sync', 5);
}

function triggerLeaderboardSync() {
  runLeaderboardSync_();
  SpreadsheetApp.getActiveSpreadsheet().toast('Leaderboard sync requested.', 'Sync', 5);
}

function scheduledSync() {
  runSync_();
}

function scheduledLeaderboardSync() {
  runLeaderboardSync_();
}

function doGet(e) {
  const type = e && e.parameter && e.parameter.type;
  const result = type === 'leaderboard' ? runLeaderboardSync_() : runSync_();
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const type = e && e.parameter && e.parameter.type;
  const result = type === 'leaderboard' ? runLeaderboardSync_() : runSync_();
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('同步工具')
    .addItem('立即同步', 'triggerSync')
    .addItem('更新排行榜', 'triggerLeaderboardSync')
    .addToUi();
}

function onEdit(e) {
  const sheet = e.source.getActiveSheet();
  const range = e.range;

  if (sheet.getName() === 'weekly_dashboard' && range.getA1Notation() === 'C1' && range.getValue() === true) {
    triggerSync();
    range.setValue(false);
  }
}
