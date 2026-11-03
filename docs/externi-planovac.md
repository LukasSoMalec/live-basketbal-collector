# Externí hodinový plánovač LIVE basketbalu (cron-job.org)

## Proč
GitHub Actions `schedule` nedoručuje pravidelná hodinová spuštění spolehlivě. Vlastní workflow již podporuje `workflow_dispatch`: stačí externí HTTP POST do GitHub API.

## 1. GitHub fine-grained personal access token
- Otevřít https://github.com/settings/personal-access-tokens/new
- Resource owner: **LukasSoMalec**; repository access: **Only select repositories** → `live-basketbal-collector`
- Repository permissions: **Actions: Read and write** (Metadata: Read je výchozí)
- Nastavit rozumnou expiraci a před vypršením token bezpečně obnovit.
- Token vložit pouze přímo do cron-job.org, **ne do zdrojového kódu, Google Sheet ani chatu**. Je to tajný přístupový údaj.

## 2. cron-job.org → Create cronjob
- Name/title: `LIVE basketbal – GitHub`
- URL: `https://api.github.com/repos/LukasSoMalec/live-basketbal-collector/actions/workflows/live-basketball.yml/dispatches`
- Request method: **POST**
- Extended/request headers:
  - `Authorization` = `Bearer <OSOBNÍ_GITHUB_TOKEN>`
  - `Accept` = `application/vnd.github+json`
  - `Content-Type` = `application/json`
- Request body (raw JSON): `{"ref":"main"}`
- Schedule: **every hour at minute 05**, timezone **Europe/Prague**.
- Uložit a spustit jednorázový **Test run / Execute now**.

## 3. Ověření
1. cron-job.org: odpověď HTTP **2xx** (podle použité verze GitHub API např. 200/204) znamená, že GitHub požadavek přijal.
2. https://github.com/LukasSoMalec/live-basketbal-collector/actions – nový workflow run musí mít `event=workflow_dispatch`, skončit `success`.
3. V Google Sheets zkontrolovat nový záznam `Kontroly`.

**Teprve po tomto trojím ověření odstranit z `.github/workflows/live-basketball.yml` sekci `schedule`. Zachovat `workflow_dispatch`.** Tím se předejde výpadku během přechodu a dvojitým pravidelným sběrům.

## Bezpečnost a provoz
- Token `Actions: write` umožňuje spouštět workflow v tomto jediném repozitáři; nastavovat jen pro vybraný repozitář.
- Přijatý dispatch není důkaz úspěšného sběru ani zápisu; je nutné sledovat i GitHub Actions a Google Sheets.
- GitHub runner stále může startovat se zpožděním. Externí plánovač odstraňuje nespolehlivost GitHub `schedule`, ale ne garantovanou dobu dokončení.
- Při vypršení tokenu může cron-job.org hlásit 401/403. Zapnout chybová upozornění.
