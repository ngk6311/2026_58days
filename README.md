# Fortune Game Google Sheet Sync

這個工具會把巨笑體系夥伴專區的修為資料同步到 Google Sheet，流程分成兩步：

1. 用 Playwright 開瀏覽器，讓你手動登入一次並保存登入狀態。
2. 用保存的登入狀態直接呼叫站內 API，整理後寫入 Google Sheet。

## 會寫入哪些工作表

- `task_rules`: 任務規則。你手動定義「哪個 quest title 算哪個每日/每週任務」。
- `members`: 目前可同步到的成員名單與所屬小隊。
- `raw_logs`: 原始得分明細。
- `quest_catalog`: 抓到的 quest title 清單，方便你建立任務規則。
- `daily_status`: 每人每日任務完成狀態。
- `weekly_status`: 每人每週任務完成狀態。
- `run_log`: 每次同步的摘要。

## 安裝

```bash
npm install
```

如果你比較習慣用 Python，也可以直接用：

```bash
python run.py init
python run.py auth
python run.py sync
```

## 設定

1. 最簡單是直接執行 `python run.py init`
2. 把 Google service account 存成 `credentials.json`
3. 把目標 Google Sheet 分享給這個 service account，權限至少 `Editor`

### 需要填的欄位

- `FORTUNE_PARTNERS_URL`: 夥伴專區網址
- `FORTUNE_SHEET_ID`: Google Sheet ID
- `FORTUNE_SCHOOL_ID`: 可選。若網站頁面抓不到 school id，可直接填這個值
- `FORTUNE_API_BASE_URL`: API 主機，預設 `https://sincheng-api.playworld.com.tw`
- `FORTUNE_WEB_APP_URL`: 可選。填入 Apps Script Web App `/exec` 網址後，`weekly_dashboard` 會自動保留手機同步連結
- `FORTUNE_TIMEZONE`: 預設 `Asia/Taipei`
- `FORTUNE_SCORE_RESET_HOUR`: 日結算小時，預設 `0`
- `FORTUNE_WEEK_START`: 週起始日，`1` 代表週一
- `FORTUNE_LOG_LIMIT`: 每位成員抓取的 score logs 筆數
- `FORTUNE_LOG_CONCURRENCY`: 同時抓取幾位成員的 score logs，預設 `8`
- `FORTUNE_LOOKBACK_DAYS`: daily/weekly 報表往回計算幾天
- `FORTUNE_SKIP_FORMATTING`: 設為 `true` 時只寫資料、不重刷 `weekly_dashboard` / `weekly_history` 格式，預設 `false`
- `GOOGLE_CREDENTIALS_PATH`: service account JSON 路徑，預設 `./credentials.json`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

### credentials.json 格式

程式支援標準 Google service account JSON，格式像這樣：

```json
{
  "type": "service_account",
  "project_id": "your-project",
  "private_key_id": "xxxx",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "your-service-account@your-project.iam.gserviceaccount.com",
  "client_id": "xxxx",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/..."
}
```

如果 `GOOGLE_CREDENTIALS_PATH` 指向的檔案存在，程式會優先讀這份 JSON。只有找不到檔案時，才會退回 `.env` 裡的 `GOOGLE_SERVICE_ACCOUNT_EMAIL` 和 `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`。

## 第一次登入

```bash
npm run auth
```

腳本會開啟瀏覽器。請自行登入，並停在夥伴專區頁面，回到終端機按 Enter 即可保存登入狀態到 `.auth/storage-state.json`。

如果你想全部用 Python 指令：

```bash
python run.py auth
```

多小隊模式請改用：

```bash
python run.py auth --team team7
python run.py auth --team team2
```

## 同步

```bash
npm run sync
```

或：

```bash
python run.py sync
```

## 最簡單流程

如果你想從零開始，照這個做就好：

1. 把 Google service account JSON 檔案放到專案資料夾，命名成 `credentials.json`
2. 執行 `python run.py init`
3. 執行 `python run.py auth`
4. 執行 `python run.py sync`

如果你希望一次跑完，也可以用：

```bash
python run.py all
```

## task_rules 格式

`task_rules` 第一列會自動建立標題，欄位如下：

- `rule_id`
- `active`
- `task_name`
- `period`
- `match_type`
- `match_value`
- `required_count`
- `notes`

### 範例

| rule_id | active | task_name | period | match_type | match_value | required_count | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| morning-practice | TRUE | 晨間修為 | daily | contains | 晨間 | 1 | quest_title 包含晨間就算完成 |
| weekly-sharing | TRUE | 週分享 | weekly | exact | 週分享 | 1 | 每週至少 1 次 |

`match_type` 支援：

- `exact`
- `contains`

## 權限說明

如果你是大隊長，腳本會同步整個大隊的所有小隊。

如果你不是大隊長，腳本只能同步你目前可見的小隊成員。

## GitHub 雲端同步

如果你要改成 GitHub 雲端執行，專案裡已經有 workflow：

- `.github/workflows/sync-fortune-game.yml`

它支援兩種方式：

- GitHub Actions 手動按 `Run workflow`
- 每天自動排程執行兩次

### 先不要 push 的檔案

以下檔案要留在本機，不要提交到 GitHub：

- `.env`
- `credentials.json`
- `.auth/storage-state.json`
- `.auth/team7-storage-state.json`
- `.auth/team2-storage-state.json`

### 要放進 GitHub Secrets 的項目

到 GitHub repo 的 `Settings -> Secrets and variables -> Actions` 建立這些 secrets：

- `FORTUNE_PARTNERS_URL`
- `FORTUNE_SHEET_ID`
- `FORTUNE_SCHOOL_ID`
- `FORTUNE_API_BASE_URL`
- `FORTUNE_TIMEZONE`
- `FORTUNE_SCORE_RESET_HOUR`
- `FORTUNE_WEEK_START`
- `FORTUNE_LOG_LIMIT`
- `FORTUNE_LOG_CONCURRENCY`
- `FORTUNE_LOOKBACK_DAYS`
- `FORTUNE_SKIP_FORMATTING`
- `FORTUNE_WEB_APP_URL`
- `GOOGLE_CREDENTIALS_JSON`
- `PLAYWRIGHT_STORAGE_STATE_JSON`
- `PLAYWRIGHT_STORAGE_STATE_JSON_TEAM7`
- `PLAYWRIGHT_STORAGE_STATE_JSON_TEAM2`

### 建議的 secrets 值

- `FORTUNE_PARTNERS_URL`: `https://www.bigsmileunity.com/bigsmile/fortune-game/partners`
- `FORTUNE_SHEET_ID`: 你的 Google Sheet ID
- `FORTUNE_SCHOOL_ID`: `yOKCHFfpakSWiRcUcMjl`
- `FORTUNE_API_BASE_URL`: `https://sincheng-api.playworld.com.tw`
- `FORTUNE_TIMEZONE`: `Asia/Taipei`
- `FORTUNE_SCORE_RESET_HOUR`: `0`
- `FORTUNE_WEEK_START`: `1`
- `FORTUNE_LOG_LIMIT`: `100`
- `FORTUNE_LOG_CONCURRENCY`: `8`
- `FORTUNE_LOOKBACK_DAYS`: `28`
- `FORTUNE_SKIP_FORMATTING`: `false`

### JSON secrets 怎麼準備

`GOOGLE_CREDENTIALS_JSON`

- 直接把 `credentials.json` 的完整內容貼進 GitHub Secret

`PLAYWRIGHT_STORAGE_STATE_JSON`

- 直接把 `.auth/storage-state.json` 的完整內容貼進 GitHub Secret

`PLAYWRIGHT_STORAGE_STATE_JSON_TEAM7`

- 直接把 `.auth/team7-storage-state.json` 的完整內容貼進 GitHub Secret

`PLAYWRIGHT_STORAGE_STATE_JSON_TEAM2`

- 直接把 `.auth/team2-storage-state.json` 的完整內容貼進 GitHub Secret

多小隊模式建議至少提供 `PLAYWRIGHT_STORAGE_STATE_JSON_TEAM7` 和 `PLAYWRIGHT_STORAGE_STATE_JSON_TEAM2`。
`PLAYWRIGHT_STORAGE_STATE_JSON` 目前只保留給舊版單隊或作為 `team7` 的備援。

### 注意

`PLAYWRIGHT_STORAGE_STATE_JSON` 裡面有登入狀態和 access token。
如果網站讓 token 過期，之後雲端同步會失敗，這時你要在本機重新跑一次：

```bash
python run.py auth
```

然後把新的 `.auth/storage-state.json` 重新貼回 GitHub Secret。
