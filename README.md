# LIVE basketbal – collector

Sběr veřejné LIVE basketbalové nabídky ze SynotTipu, Football.com, Fonbetu a 1xBitu. Výsledky se ukládají do existující Google tabulky s jedním řádkem na zápas a indikátory pokrytí jednotlivých zdrojů.

**Stav: připravené k ostrému testu.** SynotTip používá Playwright (zachytává skutečné POST odpovědi `GetLiveEventsWL` z otevřené stránky), Football.com využívá JSON API. U Fonbetu a 1xBitu se zatím pouze zjišťuje dostupnost a struktura jejich API; jejich zápasy se dosud nezapisují, protože parsery nejsou ověřené. SynotTip z GitHub-hosted runneru také zatím nebyl otestován.

## Plánované spouštění

GitHub Actions workflow `.github/workflows/live-basketball.yml` je nastaven na **každých 15 minut** (UTC `:00`, `:15`, `:30`, `:45`; stejné minuty platí v ČR). GitHub může plánované spuštění opozdit.

**Automatické spouštění je aktivní.** První ostrý test 2026-11-02 prošel: SynotTip 16 LIVE zápasů a 8 nových řádků zapsaných do Google Sheets. GitHub Actions může běhy opozdit. U 96 spuštění denně může být spotřeba minut v soukromém repozitáři významná (a případně placená). Pozastavení: GitHub → Actions → LIVE basketbal - 4 sazkovky → menu `...` → Disable workflow. Bez nového workflow už nebudou běžet kontroly.

## Propojení Google Sheets (jednorázově)

Cílová tabulka: https://docs.google.com/spreadsheets/d/1LWy7tTceA-kP_OMSlNRm1cLrzxAx0hMq4DI4pbzYOwI/edit

1. Otevři tabulku → **Rozšíření → Apps Script**. Nahraď obsah `Code.gs` kompletním obsahem `GoogleAppsScript.gs` z tohoto repozitáře.
2. Apps Script → **Nastavení projektu → Vlastnosti skriptu**: přidej `INGEST_KEY` = silný náhodný soukromý klíč. Nesdílej jej veřejně ani zde v chatu.
3. Apps Script → **Nasadit → Nové nasazení → Webová aplikace**. „Spustit jako“ nastav **já**, „Kdo má přístup“ **Kdokoli**. Autorizuj přístup a zkopíruj URL končící `/exec`.
4. GitHub → **Settings → Secrets and variables → Actions → Secrets**: přidej `SHEETS_WEBAPP_URL` = URL z kroku 3 a `SHEETS_INGEST_KEY` = přesně stejný soukromý klíč.
5. GitHub → **Actions → LIVE basketbal - 4 sazkovky → Run workflow**. Zkontroluj logy, případně artefakt `output/latest.json`, a potvrď zápis do záložek **Kontroly**, **Zdroje**, **Zápasy**.
6. Po úspěšném testu je už patnáctiminutový plán v GitHub Actions aktivovaný. Průběh sleduj v **Actions** a výsledky kontroluj v Google Sheets. Žádnou proměnnou `ENABLE_LIVE_COLLECTOR` už není nutné nastavovat.

Bez přítomnosti obou secrets workflow při ručním spuštění skončí chybou ještě před instalací Pythonu a prohlížeče. Veřejná Apps Script URL nevydává právo k zápisu bez tajného klíče; přesto je tento model nutné chápat jako jednoduchý ingest endpoint, nikoli detailní autentizační systém.

## Co se ukládá

Záznamy získané LIVE a spárované přes `sr:match:<ID>`, nebo pouze jednoznačné názvy týmů a datum. Stav `ANO` má přednost a později se nepřepíše jako `NE`. Pokud je zdroj nedostupný, zapíše se stav kontroly, nikoli falešná absence zápasu. SynotTip long-poll snapshoty nemusí být úplné. Ze samotné absence zápasu se proto automaticky nesmí vyvodit `NE`.

## Lokální test

```bash
python -m pip install -r requirements.txt
python -m playwright install chromium
python -m unittest discover -s tests -v
python collector.py
```

Bez `SHEETS_WEBAPP_URL` a `SHEETS_INGEST_KEY` jde o dry-run: ukládá se pouze soubor `output/latest.json`. Pro ostré načítání bookmakerů je nutné síťové připojení. Žádné přihlašování, obcházení CAPTCHA, kopírování cookies ani zadávání sázek.
