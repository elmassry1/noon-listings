# noon Minutes · New listings tool

- `/` — vendor portal (EN/AR): fill a table or upload any sheet; columns auto-detected.
- `/admin` — tracker, pricing, NIS filler, ZSKU import, 12 upload templates (login = task-portal account; admins in `lt_admins`).

Stack: Vite + React, Supabase (Noon-Portal project, `lt_*` tables, `lt-images` / `lt-files` buckets, `lt-ai` edge function — needs `ANTHROPIC_API_KEY` secret), Vercel.
Daily Gmail/Sheets sync runs as a Claude scheduled task — see `docs/daily-sync-prompt.md`.
