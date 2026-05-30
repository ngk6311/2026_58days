# Google Sheet Apps Script

## 用途

把 `Code.gs` 貼到 Google Sheet 的 Apps Script，之後就能：

- 在上方選單看到 `同步工具 -> 立即同步`
- 手動觸發 GitHub Actions workflow
- 在 `weekly_dashboard!A1` 顯示同步狀態

## 你要做的事

1. 打開 Google Sheet
2. 點 `擴充功能 -> Apps Script`
3. 把 `Code.gs` 全部貼進去
4. 儲存
5. 到 Apps Script 的 `Project Settings`
6. 在 `Script Properties` 新增：
   - Key: `GITHUB_TOKEN`
   - Value: 你的 GitHub Personal Access Token

## GitHub Token 權限

至少要能觸發 workflow，建議包含：

- `repo`
- `workflow`
