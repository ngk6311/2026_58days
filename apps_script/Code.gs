function triggerSync() {
  const owner = 'ngk6311';
  const repo = '2026_58days';
  const workflowId = 'sync-fortune-game.yml';
  const branch = 'main';
  const statusSheetName = 'weekly_dashboard';
  const statusCell = 'A1';

  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error('Missing GITHUB_TOKEN in Script Properties');
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(statusSheetName);
  if (sheet) {
    sheet.getRange(statusCell).setValue('同步中...');
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
    payload: JSON.stringify({
      ref: branch,
    }),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code >= 200 && code < 300) {
    if (sheet) {
      sheet.getRange(statusCell).setValue('已送出同步，請稍候 10~60 秒');
    }
    SpreadsheetApp.getActiveSpreadsheet().toast('已送出同步指令，請稍候 10~60 秒', '同步中', 5);
    return;
  }

  if (sheet) {
    sheet.getRange(statusCell).setValue(`同步送出失敗: ${code}`);
  }
  throw new Error(`GitHub trigger failed: ${code}\n${body}`);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('同步工具')
    .addItem('立即同步', 'triggerSync')
    .addToUi();
}
