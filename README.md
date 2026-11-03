# LIVE basketbal – collector

Sběr veřejné LIVE basketbalové nabídky ze SynotTipu, Football.com, Fonbetu a 1xBitu. Výsledky se ukládají do existující Google tabulky s jedním řádkem na zápas a indikátory pokrytí jednotlivých zdrojů.

**Stav: všechny 4 zdroje ostrým testem ověřené (SynotTip, Football.com, Fonbet, 1xBit).** SynotTip zachytává LIVE POST odpovědi přes Playwright, Football.com kombinuje JSON API a záložní Chromium při HTTP 202, Fonbet čte veřejné `/events/listBase` a 1xBit čte `service-api/main-live-feed/v3/games1x2`. Poslední ověřený běh 2026-11-02 v 18:57 zachytil 18 SynotTip, 17 Football.com, 14 Fonbet a 19 1xBit LIVE zápasů. Ve výpisu 1xBitu se uznávají jen zápasy basketbalu (`sport.id=3`), v LIVE sekci, s běžící čtvrtinou; virtuální soutěže NBA 2K a IPBL jsou vyloučené. Výsledek se ukládá do stejné Google tabulky. Úplnost zdroje se nedá garantovat, protože 1xBit URL obsahuje `count=40` a jednotlivé feedy mohou být omezené.

## Plánované spouštění

Plánovač **cron-job.org** spouští každých **15 minut** (minuty :00, :15, :30, :45 v čase Europe/Prague) GitHub Actions přes `workflow_dispatch`. V GitHub workflow není interní `schedule` ani trvalý `push` trigger. Runner může začít se zpožděním. Spuštění ověříš na stránce GitHub Actions a na listu `Kontroly`.

## Propojení Google Sheets (jednorázově)

Cílová tabulka: https://docs.google.com/spreadsheets/d/1LWy7tTceA-kP_OMSlNRm1cLrzxAx0hMq4DI4pbzYOwI/edit

1. Otevři tabulku → **Rozšíření → Apps Script**. Nahraď obsah `Code.gs` kompletním obsahem `GoogleAppsScript.gs` z tohoto repozitáře.
2. Apps Script → **Nastavení projektu → Vlastnosti skriptu**: přidej `INGEST_KEY` = silný náhodný soukromý klíč. Nesdílej jej veřejně ani zde v chatu.
3. Apps Script → **Nasadit → Nové nasazení → Webová aplikace**. „Spustit jako“ nastav **já**, „Kdo má přístup“ **Kdokoli**. Autorizuj přístup a zkopíruj URL končící `/exec`.
4. GitHub → **Settings → Secrets and variables → Actions → Secrets**: přidej `SHEETS_WEBAPP_URL` = URL z kroku 3 a `SHEETS_INGEST_KEY` = přesně stejný soukromý klíč.
5. GitHub → **Actions → LIVE basketbal - 4 sazkovky → Run workflow**. Zkontroluj logy, případně artefakt `output/latest.json`, a potvrď zápis do záložek **Kontroly**, **Zdroje**, **Zápasy**.
6. Po úspěšném testu je už dvacetiminutový plán v GitHub Actions aktivovaný. Průběh sleduj v **Actions** a výsledky kontroluj v Google Sheets. Žádnou proměnnou `ENABLE_LIVE_COLLECTOR` už není nutné nastavovat.

Bez přítomnosti obou secrets workflow při ručním spuštění skončí chybou ještě před instalací Pythonu a prohlížeče. Veřejná Apps Script URL nevydává právo k zápisu bez tajného klíče; přesto je tento model nutné chápat jako jednoduchý ingest endpoint, nikoli detailní autentizační systém.

## Co se ukládá

Záznamy získané LIVE a spárované přes `sr:match:<ID>`, nebo pouze jednoznačné názvy týmů a datum. Stav `ANO` má přednost a později se nepřepíše jako `NE`. Pokud je zdroj nedostupný, zapíše se stav kontroly, nikoli falešná absence zápasu. SynotTip long-poll snapshoty nemusí být úplné. Ze samotné absence zápasu se proto automaticky nesmí vyvodit `NE`.

## Párování a Apps Script

Pro nové zápisy se Fonbet a 1xBit párují podle data a přesně shodných či jednotlivě ověřených dvojic týmů s jednoznačným ID Sportradar získaným od SynotTipu nebo Football.com. U některých 1xBit utkání je opačně pořadí týmů; obrácené dvojice se propojují výhradně přes konkrétně ověřené aliasy. Pokud ID nelze jednoznačně prokázat, zdroj se nezapočte k cizímu zápasu a dostane oddělený řádek. Zároveň byl opraven soubor `GoogleAppsScript.gs`: původní `getValues()` vracelo pro datumový sloupec objekty `Date`, které se nesrovnávaly s textovým ISO datem. **Změna v souboru GitHubu se do již nasazeného Apps Scriptu nepromítne automaticky.** Chce-li uživatel nasadit tuto obecnou opravu, musí v tabulce přepsat kód v editoru Apps Script aktualizovanou verzí a přes `Nasadit → Spravovat nasazení → Upravit → Nová verze → Nasadit` aktualizovat stávající webovou aplikaci. Tím může zachovat stejnou URL a GitHub Secrets.

Při čistém integračním testu 2026-11-02 v 19:19 se podařilo spojit `AS Papagou – Panionios BC Atény` napříč všemi čtyřmi zdroji do jednoho řádku. Test zapsal 44 řádků a 102 potvrzení dostupnosti; ostatní odlišné názvy (Zenit/Igokea, Würzburg/Tartu, Uppsala/Borås atd.) však ještě vytvořily duplicitní řádky. Proto byla poté v `GoogleAppsScript.gs` posílena obecná normalizace klubů, měst, diakritiky a kategorií mužů/žen/U19 včetně opačného pořadí týmů. Součástí GitHub Actions je test `tests/test_apps_script.cjs`, který kontroluje správné sloučení i chybné případy. **Novinka: automatické zpětné slučování duplicit.** Aktuální `GoogleAppsScript.gs` po každém přijetí dat z GitHubu prochází také starší zápasy v záložce `Zápasy`. Jednoznačně shodné řádky sloučí podle data, týmů, soutěžní kategorie a skutečných Sportradar ID; při konfliktu dvou různých ID je automaticky neslučuje. Zachovává všechna `ANO`, nejstarší první a nejnovější poslední zachycení a původní poznámky. Počet kontrol se nastavuje na maximum původních hodnot (součet by při jednom sběru mohl stejnou kontrolu započítat několikrát). Všechny původní záznamy před sloučením kopíruje do automaticky vytvořené záložky `Archiv duplicit`. Potenciální ale neprokazatelné shody se pouze označí v poznámce textem `ZKONTROLOVAT DUPLIKAT`. Dávkové slučování se provede při každém 20minutovém zápisu, bez zvláštního plánovače. Zpracování je otestováno v `tests/test_apps_script_dedupe.cjs` na simulované tabulce.

**Nutný jednorázový krok: tuto verzi z GitHubu znovu nasadit v Google Apps Scriptu.** Přepsat obsah `Code.gs`, pak `Nasadit → Spravovat nasazení → Upravit (tužka) → Nová verze → Nasadit`. GitHub workflow samo o sobě neupravuje nasazenou webovou aplikaci. Po aktualizaci už se opravy budou provádět při každém běhu automaticky; tabulku není třeba čistit ani znovu zakládat.

## Trvalé ruční slučování zápasů

Po ručním sloučení přes `ManualMerge.gs` se původní řádky ukládají do listu `Archiv duplicit` s rolí `MANUAL MERGED FROM`. Nová verze `GoogleAppsScript.gs` tato historická rozhodnutí při každém ingestu znovu načítá: mapuje původní název soutěže a obou týmů (jen pro původní zdroj, který měl `ANO`) na **aktuálně zachovaný zápas**. Zvládá i více navazujících ručních sloučení, například A → B → C. Pokud už se smazaná varianta mezitím znovu objevila, provede navíc retrospektivní úklid včetně archivace, bez ztráty potvrzených `ANO`.

Vazby **nepřepisují konfliktní ověřená SportRadar ani neprůhledná ID**; neaktivují se pro rychlé `BSKT CUP` zápasy a nikdy nepřekračují datum utkání. Nejednoznačné vazby se nepoužijí. Archiv nemaž, je zdrojem trvalých aliasů i historie. Pro aktivaci je nutné nahrát aktuální `GoogleAppsScript.gs` a vytvořit novou verzi stávající Apps Script webové aplikace. `ManualMerge.gs` není nutné znovu měnit.

## Filtrace soutěží a evidence vyřazených LIVE zápasů

Sledujeme **klasické soutěžní basketbalové zápasy**, ne bookmaker-only minisoutěže, virtuální hry ani eBasket. Sdílený filtr všech čtyř zdrojů vyřazuje mimo jiné `FrostBall`, samostatné `Premier League` / `Premier League A`, `IPBL`, `BSKT CUP`, `Table Basketball League` a e-sport. Konkrétní názvy jako `Israel. Premier League` **nesmí být automaticky vyřazeny** kvůli slovu Premier.

Parsery ukládají ke každému funkčnímu LIVE zdroji pole `rejectedCompetitions` (zdroj je součástí mateřského objektu; položka obsahuje `competition`, `reason`, `count`, `example`). Jde o **počty různých LIVE událostí v jednom sběru**, deduplikované přes sportovní ID, případně dvojici týmů. Nepočítají se nespuštěné zápasy, nedostupné API ani neplatná JSON schémata.

Po aktualizaci **GoogleAppsScript.gs** a **novém nasazení stávající Apps Script webové aplikace** se automaticky vytvoří list `Vyřazené soutěže`. Na každou kombinaci zdroj + název soutěže + důvod existuje jeden řádek s prvním a posledním výskytem, počtem kontrol s výskytem, součtem výskytů v kontrolách, počtem v poslední kontrole a příkladem utkání. Součet výskytů **není počet jedinečných utkání za celou historii**, protože stejný zápas může probíhat více kontrolami.

Soubor `ManualMerge.gs` je volitelný a nemění zpracování tohoto auditu; tento list je **jen evidence, ne editovatelný whitelist nebo blacklist**. Změna pravidel se zatím provádí v `collector.py`. Staré údaje se zpětně neodhadují.

## Lokální test

```bash
python -m pip install -r requirements.txt
python -m playwright install chromium
python -m unittest discover -s tests -v
python collector.py
```

Bez `SHEETS_WEBAPP_URL` a `SHEETS_INGEST_KEY` jde o dry-run: ukládá se pouze soubor `output/latest.json`. Pro ostré načítání bookmakerů je nutné síťové připojení. Žádné přihlašování, obcházení CAPTCHA, kopírování cookies ani zadávání sázek.
