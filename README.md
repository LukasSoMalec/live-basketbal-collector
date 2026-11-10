# LIVE basketbal – collector

Sběr veřejné LIVE basketbalové nabídky ze SynotTipu, Football.com, Fonbetu a 1xBitu. Výsledky se ukládají do existující Google tabulky s jedním řádkem na zápas a indikátory pokrytí jednotlivých zdrojů.

**Stav: všechny 4 zdroje ostrým testem ověřené (SynotTip, Football.com, Fonbet, 1xBit).** SynotTip zachytává LIVE POST odpovědi přes Playwright, Football.com kombinuje JSON API a záložní Chromium při HTTP 202, Fonbet čte veřejné `/events/listBase` a 1xBit čte `service-api/main-live-feed/v3/games1x2`. Poslední ověřený běh 2026-11-02 v 18:57 zachytil 18 SynotTip, 17 Football.com, 14 Fonbet a 19 1xBit LIVE zápasů. Ve výpisu 1xBitu se uznávají jen zápasy basketbalu (`sport.id=3`), v LIVE sekci, s běžící čtvrtinou; virtuální soutěže NBA 2K a IPBL jsou vyloučené. Výsledek se ukládá do stejné Google tabulky. Úplnost zdroje se nedá garantovat, protože 1xBit URL obsahuje `count=40` a jednotlivé feedy mohou být omezené.

## Plánované spouštění

GitHub Actions nyní spouští collector **jednou za hodinu, vždy v HH:10 v čase Europe/Prague** (`cron: '10 * * * *'`, `timezone: Europe/Prague`). Plánovaný start se může na GitHubu opozdit. Limit běhu GitHub jobu je 20 minut. **Starou úlohu na cron-job.org je nutné ručně vypnout**: její volání `workflow_dispatch` bez `manual_confirm: true` už není povoleno spustit sběr. Pro ruční test z GitHub Actions zaškrtni potvrzení `manual_confirm`. Spuštění ověříš na GitHub Actions a v záložce `Kontroly`.

## Propojení Google Sheets (jednorázově)

Cílová tabulka: https://docs.google.com/spreadsheets/d/1LWy7tTceA-kP_OMSlNRm1cLrzxAx0hMq4DI4pbzYOwI/edit

1. Otevři tabulku → **Rozšíření → Apps Script**. Nahraď obsah `Code.gs` kompletním obsahem `GoogleAppsScript.gs` z tohoto repozitáře.
2. Apps Script → **Nastavení projektu → Vlastnosti skriptu**: přidej `INGEST_KEY` = silný náhodný soukromý klíč. Nesdílej jej veřejně ani zde v chatu.
3. Apps Script → **Nasadit → Nové nasazení → Webová aplikace**. „Spustit jako“ nastav **já**, „Kdo má přístup“ **Kdokoli**. Autorizuj přístup a zkopíruj URL končící `/exec`.
4. GitHub → **Settings → Secrets and variables → Actions → Secrets**: přidej `SHEETS_WEBAPP_URL` = URL z kroku 3 a `SHEETS_INGEST_KEY` = přesně stejný soukromý klíč.
5. GitHub → **Actions → LIVE basketbal - 4 sazkovky → Run workflow → zaškrtni potvrzení ručního spuštění**. Zkontroluj logy, případně artefakt `output/latest.json`, a potvrď zápis do záložek **Kontroly**, **Zdroje**, **Zápasy**.
6. Po úspěšném testu je hodinový plán (:10) v GitHub Actions aktivovaný. Průběh sleduj v **Actions** a výsledky kontroluj v Google Sheets. Žádnou proměnnou `ENABLE_LIVE_COLLECTOR` už není nutné nastavovat.

Bez přítomnosti obou secrets workflow při ručním spuštění skončí chybou ještě před instalací Pythonu a prohlížeče. Veřejná Apps Script URL nevydává právo k zápisu bez tajného klíče; přesto je tento model nutné chápat jako jednoduchý ingest endpoint, nikoli detailní autentizační systém.

## Co se ukládá

Záznamy získané LIVE a spárované přes `sr:match:<ID>`, nebo pouze jednoznačné názvy týmů a datum. Stav `ANO` má přednost a později se nepřepíše jako `NE`. Pokud je zdroj nedostupný, zapíše se stav kontroly, nikoli falešná absence zápasu. SynotTip long-poll snapshoty nemusí být úplné. Ze samotné absence zápasu se proto automaticky nesmí vyvodit `NE`.

## Párování a Apps Script

Pro nové zápisy se Fonbet a 1xBit párují podle data a přesně shodných či jednotlivě ověřených dvojic týmů s jednoznačným ID Sportradar získaným od SynotTipu nebo Football.com. U některých 1xBit utkání je opačně pořadí týmů; obrácené dvojice se propojují výhradně přes konkrétně ověřené aliasy. Pokud ID nelze jednoznačně prokázat, zdroj se nezapočte k cizímu zápasu a dostane oddělený řádek. Zároveň byl opraven soubor `GoogleAppsScript.gs`: původní `getValues()` vracelo pro datumový sloupec objekty `Date`, které se nesrovnávaly s textovým ISO datem. **Změna v souboru GitHubu se do již nasazeného Apps Scriptu nepromítne automaticky.** Chce-li uživatel nasadit tuto obecnou opravu, musí v tabulce přepsat kód v editoru Apps Script aktualizovanou verzí a přes `Nasadit → Spravovat nasazení → Upravit → Nová verze → Nasadit` aktualizovat stávající webovou aplikaci. Tím může zachovat stejnou URL a GitHub Secrets.

Při čistém integračním testu 2026-11-02 v 19:19 se podařilo spojit `AS Papagou – Panionios BC Atény` napříč všemi čtyřmi zdroji do jednoho řádku. Test zapsal 44 řádků a 102 potvrzení dostupnosti; ostatní odlišné názvy (Zenit/Igokea, Würzburg/Tartu, Uppsala/Borås atd.) však ještě vytvořily duplicitní řádky. Proto byla poté v `GoogleAppsScript.gs` posílena obecná normalizace klubů, měst, diakritiky a kategorií mužů/žen/U19 včetně opačného pořadí týmů. Součástí GitHub Actions je test `tests/test_apps_script.cjs`, který kontroluje správné sloučení i chybné případy. **Novinka: automatické zpětné slučování duplicit běží ODDĚLENĚ.** Aktuální `GoogleAppsScript.gs` při přijetí dat z GitHubu zpracovává jen nový snapshot; samostatný `ScheduledDedupe.gs` postupně prochází historické zápasy v záložce `Zápasy`. Jednoznačně shodné řádky sloučí podle data, týmů, soutěžní kategorie a skutečných Sportradar ID; při konfliktu dvou různých ID je automaticky neslučuje. Zachovává všechna `ANO`, nejstarší první a nejnovější poslední zachycení a původní poznámky. Počet kontrol se nastavuje na maximum původních hodnot (součet by při jednom sběru mohl stejnou kontrolu započítat několikrát). Všechny původní záznamy před sloučením kopíruje do automaticky vytvořené záložky `Archiv duplicit`. Potenciální ale neprokazatelné shody se pouze označí v poznámce textem `ZKONTROLOVAT DUPLIKAT`. Historické slučování se spouští nezávislým časovým triggerem Apps Scriptu, přibližně jednou za hodinu (kolem minuty :40 pražského času); vždy prověří jen jeden den a nejvýše 30 odstraňovaných řádků v 15 skupinách. Zpracování je otestováno v `tests/test_apps_script_dedupe.cjs` na simulované tabulce.

**Nutné jednorázové nasazení:** aktualizovat `GoogleAppsScript.gs` ve stávajícím projektu Apps Script, přidat soubor `ScheduledDedupe.gs`, pak `Nasadit → Spravovat nasazení → Upravit → Nová verze → Nasadit` (zachovat /exec URL). V editoru **jednou ručně spusť** `installScheduledDedupe` a potvrď oprávnění – bez tohoto kroku se samostatná deduplikace automaticky nespustí. Po instalaci můžeš zkusit `runScheduledDedupe` ručně a otevřít Provedení (Executions). Nedávej přímo `planHistoricalDeduplication_` do triggeru. GitHub workflow nikdy samo nenahraje nový kód do Apps Scriptu.


### Oddělené background čištění (nové od 10. 11. 2026)

1. **Sběr:** GitHub Actions v HH:10 pošle JSON pouze do `saveSnapshot_`. V této cestě již neprobíhá plánování ani mazání historických duplicit. Stále zůstává konzervativní párování nových LIVE zápasů a učení potvrzených aliasů.
2. **Historie:** `ScheduledDedupe.gs` obsahuje `runScheduledDedupe`, který získá zámek, prochází jednu datumovou skupinu ze všech fyzických řádků, ověří konfliktní ID/kategorie, omezuje počet sloučení, archivuje původní řádky a teprve pak maže duplicity. Průběžný datumový kurzor je v Script Properties.
3. **Trigger:** `installScheduledDedupe` vytvoří hodinový time-driven trigger kolem :40 (Google může spustit o ±15 minut jindy); pokryje historické dny postupně. Opakované spuštění instalace nezaloží další kopie téhož triggeru.
4. **Bezpečnost:** používá stejný `LockService.getScriptLock()` jako webový ingest a ruční slučování. Pokud sběr právě zapisuje, background se přeskočí. Každý běh před mazáním zapisuje do `Archiv duplicit`. `AI sloučení` dál vyžaduje potvrzení uživatele.
5. **Limity:** Apps Script má limit 6 minut na jedno spuštění a celkový limit času triggerů (u běžných Google účtů 90 minut/den). Proto se nečistí vše najednou. Zatím nejde o potvrzenou opravu produkčního zápisu, dokud se kód ručně nenahraje do Apps Scriptu a neprojde jeden reálný ingest + background běh.

## AI fronta sloučení (stabilní klíče, ne čísla řádků)

Záložka **AI sloučení** v [našem Google Sheetu](https://docs.google.com/spreadsheets/d/1LWy7tTceA-kP_OMSlNRm1cLrzxAx0hMq4DI4pbzYOwI/edit#gid=915503390) obsahuje návrhy, které ChatGPT průběžně vyhodnotil. **Tato záložka je statická fronta** – další AI analýza se musí vytvořit znovu v chatu, neprobíhá sama při hodinových kontrolách a nevyžaduje OpenAI API klíč.

Každá skupina má stav `SLOUČIT` (jistější shoda) nebo `PROVĚŘIT` (nejasný případ). Obsahuje klíč zachovaného zápasu a JSON seznam dalších klíčů, orientaci domácích/hostů, názvy a orientační čísla řádků. **Čísla řádků neslouží k mazání**. Backend po kliknutí vždy znovu vyhledá aktuální klíče, ověří datum, kategorii, event ID, zdrojové konflikty a archivuje originály před změnou. Skupiny označené `PROVĚŘIT` nikdy automaticky neslučuje.

Ke stávajícímu Apps Script projektu přidej nový soubor [AIQueueMerge.gs](AIQueueMerge.gs), aktualizuj hlavní [GoogleAppsScript.gs](GoogleAppsScript.gs) a v Tampermonkey nahraď skript verzí 1.1.2+ z [LiveBasketbalAutoMerge.user.js](LiveBasketbalAutoMerge.user.js). Používá se již nastavený `MERGE_KEY`; nové heslo není potřeba. **Aktualizuj stávající nasazení webové aplikace na novou verzi** a zachovej `/exec` URL. V TM klikni na **AUTO SPOJENÍ → AI fronta → Sloučit jisté**. Velké množství návrhů backend bezpečně zpracovává po skupinách, TM je spustí postupně. Stav `SLOUČENO`/`BLOKOVÁNO` a důvod je v AI záložce.

Na uživatelovu žádost se při potvrzení také **archivují a odstraňují zdánlivé zápasy, které mají v obou názvech víc týmů oddělených `/`** (například `Utah Jazz/Cleveland Cavaliers – Pelicans/Thunder`). Zachováváme jednu součást na jeden jednotlivý zápas; kombinované souhrnné výpisy z 1xBit se při dalších ingestích ignorují. Jediný lomítkový název klubu není důvodem k smazání. Archivní role je `REMOVED MULTI-FIXTURE` a z těchto řádků se neučí aliasy.
## Tampermonkey: náhled a slučování duplicit

Soubor **[LiveBasketbalAutoMerge.user.js](LiveBasketbalAutoMerge.user.js)** přidá do Google tabulky tlačítko **AUTO SPOJENÍ**. Vypíše návrhy duplicit podle data, soutěže, kategorie, ověřených ID, názvů týmů a naučených aliasů. Nic se nesmaže bez potvrzení. Bezpečnější shody jsou předvybrané, nejisté návrhy je nutné označit ručně. Nejde o volání AI modelu, ale o konzervativní pravidlové párování.

Při potvrzení nové funkce v **AutoMerge.gs** znovu prověří platnost návrhů, zamknou zápis, spojí všechna ANO a archivují oba původní řádky **před** odstraněním duplicit. Při obráceném pořadí soupeřů uloží příznak REVERSED a budoucí aliasy se naučí ve správném směru.

**Jednorázové nastavení:**

1. Do současného projektu Google Apps Script přidej nový soubor `AutoMerge.gs` a nahraď původní `GoogleAppsScript.gs` nejnovější verzí z repozitáře. `ManualMerge.gs` není nutné měnit.
2. V Nastavení projektu → Vlastnosti skriptu vytvoř nový silný tajný klíč `MERGE_KEY` (minimálně 32 znaků). **Nepoužívej INGEST_KEY.**
3. V Nasadit → Spravovat nasazení → Upravit aktualizuj **existující** webovou aplikaci na novou verzi, ať zůstane stejné `/exec` URL používané GitHubem.
4. Do Tampermonkey vlož obsah `LiveBasketbalAutoMerge.user.js`. V Google Sheets otevři tlačítko AUTO SPOJENÍ, jednou zadej `/exec` URL a svůj `MERGE_KEY`.
5. Vyhodnoť návrhy a potvrď vybraná sloučení. Doporučujeme před prvním použitím mít připravenou Historii verzí.

Klíč je uložen pouze lokálně v Tampermonkey. Nikdy ho nikomu neposílej. Naplánovaný hodinový sběr v HH:10 a jeho GitHub tajný klíč fungují nezávisle na ručním slučování. Slučování probíhá jen na explicitní kliknutí uživatele.
## Trvalé ruční slučování zápasů

Po ručním sloučení přes `ManualMerge.gs` se původní řádky ukládají do listu `Archiv duplicit` s rolí `MANUAL MERGED FROM`. Nová verze `GoogleAppsScript.gs` tato historická rozhodnutí při každém ingestu znovu načítá: mapuje původní název soutěže a obou týmů (jen pro původní zdroj, který měl `ANO`) na **aktuálně zachovaný zápas**. Zvládá i více navazujících ručních sloučení, například A → B → C. Pokud už se smazaná varianta mezitím znovu objevila, provede navíc retrospektivní úklid včetně archivace, bez ztráty potvrzených `ANO`.

Vazby na **konkrétní zápasy** nepřepisují konfliktní ověřená SportRadar ani neprůhledná ID; neaktivují se pro rychlé `BSKT CUP` zápasy a nikdy nepřekračují datum utkání. Nejednoznačné vazby se nepoužijí. Archiv nemaž, je zdrojem trvalých aliasů i historie. Pro aktivaci je nutné nahrát aktuální `GoogleAppsScript.gs` a vytvořit novou verzi stávající Apps Script webové aplikace. `ManualMerge.gs` není nutné znovu měnit.

### Znovupoužitelné aliasy názvů týmů

Skript navíc automaticky založí **`Aliasy týmů`**, pokud ještě neexistuje. Z explicitně potvrzených ručních sloučení v `Archiv duplicit` do něj doplní pro každou sázkovku a soutěž zvlášť ekvivalence **název týmu u zdroje → kanonický název týmu** (pro domácí i hosty). Ověřené synonymum se pak používá i v **jiném utkání a jiný den**, přestože původní soupeř už nehraje. Při hledání shody musí souhlasit oba týmy utkání, den, kategorie dospělí/ženy/mládež, související soutěž a nesmějí být konfliktní ověřená ID. Neznámé nebo konfliktní aliasy nevyvolávají nucené sloučení. Původní pravidla pro aktuální zápasy zůstávají zachována.

Sloupce `Aliasy týmů`: **Zdroj**, **Soutěž u zdroje**, **Název týmu u zdroje**, **Odpovídající tým**, **Kategorie** (např. `adult|unspecified`), **Soutěž cílového týmu**, **Původ**, **Aktivní** (`ANO` / `NE`). Alias lze vypnout změnou `Aktivní` na `NE`, bez dalšího nasazování. Už ručně zadané záznamy se nepřepisují; při nejednoznačném automatickém učení se nový alias nevytvoří. Vytvoření listu i doplnění starších archivovaných ručních sloučení proběhne při první kontrole po nasazení. Soubor `ManualMerge.gs` se měnit nemusí.



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
