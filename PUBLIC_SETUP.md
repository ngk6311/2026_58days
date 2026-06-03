# Public Repo Setup

This repository is prepared for a public GitHub visibility model.

## Tracked vs private config

- `teams.json`: public-safe team metadata only
- `teams.local.json`: private team overrides, ignored by git
- `teams.local.example.json`: example private config template

Put sensitive values such as these in `teams.local.json` instead of `teams.json`:

- `sheet_id`
- `school_id`
- `web_app_url`

## Local setup

1. Copy `teams.local.example.json` to `teams.local.json`
2. Fill in the live values for each team
3. Keep using your local `.env`, `credentials.json`, and `.auth/*.json`

## GitHub Actions setup

Store the full JSON content of `teams.local.json` in the GitHub Actions secret:

- `TEAMS_CONFIG_JSON`

The workflow writes that secret back to `teams.local.json` at runtime.

You still need the existing secrets such as:

- `GOOGLE_CREDENTIALS_JSON`
- `PLAYWRIGHT_STORAGE_STATE_JSON_TEAM7`
- `PLAYWRIGHT_STORAGE_STATE_JSON_TEAM2`
- `PLAYWRIGHT_STORAGE_STATE_JSON_TEAM3`
- `PLAYWRIGHT_STORAGE_STATE_JSON_TEAM4`
- `PLAYWRIGHT_STORAGE_STATE_JSON_TEAM5`
- `PLAYWRIGHT_STORAGE_STATE_JSON_TEAM9`
- `PLAYWRIGHT_STORAGE_STATE_JSON_BRIGADE1`
- `PLAYWRIGHT_STORAGE_STATE_JSON_BRIGADE2`
