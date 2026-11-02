/**
 * Připojit jako Google Apps Script ke stávajícímu dokumentu Google Sheets.
 * Script Properties: INGEST_KEY = silný náhodný tajný klíč (64 hex znaků).
 * Deploy -> Web App -> Execute as: Me, Who has access: Anyone.
 * Nikdy sem nevkládej cookies nebo token ze SynotTipu.
 */
const SPREADSHEET_ID = '1LWy7tTceA-kP_OMSlNRm1cLrzxAx0hMq4DI4pbzYOwI';
const SOURCES = ['SynotTip', 'Fonbet', '1xBit', 'Football.com'];
const COL_BY_SOURCE = { 'SynotTip': 5, 'Fonbet': 6, '1xBit': 7, 'Football.com': 8 }; // zero-based

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const requiredKey = PropertiesService.getScriptProperties().getProperty('INGEST_KEY');
    if (!requiredKey || !body.key || body.key !== requiredKey) {
      return json_({ok: false, error: 'Unauthorized'});
    }
    if (!lock.tryLock(25000)) return json_({ok: false, error: 'Locked; retry next run'});
    return json_(saveSnapshot_(body));
  } catch (err) {
    return json_({ok: false, error: String(err.message || err).slice(0, 300)});
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function doGet() {
  return json_({ok: true, service: 'LIVE basketball ingest', note: 'POST requires key'});
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
}

function norm_(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normTeam_(text) {
  // Remove only generic team prefixes, not cities or distinguishing words.
  return norm_(text).replace(/^(bc|kk|sk|bk)\s+/, '').trim();
}

function eventId_(text) {
  const m = String(text || '').match(/(?:sr:match:|ExternalID\s*[:=]?\s*['"]?)(\d{5,})/i);
  return m ? 'sr:match:' + m[1] : '';
}

function matchDateKey_(value) {
  // getValues() returns Date objects for date-formatted Sheets cells, even
  // when the API originally wrote an ISO string such as '2026-11-02'.
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Europe/Prague', 'yyyy-MM-dd');
  }
  return String(value || '').trim().slice(0, 10);
}

function exactKey_(date, home, away) {
  return `${matchDateKey_(date)}|${normTeam_(home)}|${normTeam_(away)}`;
}

function saveSnapshot_(body) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const gamesSheet = ss.getSheetByName('Zápasy');
  const checksSheet = ss.getSheetByName('Kontroly');
  const srcSheet = ss.getSheetByName('Zdroje');
  if (!gamesSheet || !checksSheet || !srcSheet) throw new Error('Missing expected sheet tab');
  if (!Array.isArray(body.sources)) throw new Error('Missing sources');
  const checkedDate = new Date(body.checkedAt);
  if (isNaN(checkedDate.getTime())) throw new Error('Invalid checkedAt');
  const stamp = Utilities.formatDate(checkedDate, 'Europe/Prague', 'yyyy-MM-dd HH:mm:ss');
  const lastRow = gamesSheet.getLastRow();
  const originalRows = lastRow > 1 ? gamesSheet.getRange(2, 1, lastRow - 1, 13).getValues() : [];
  const rows = originalRows.map(r => r.slice());
  const idIndex = new Map();
  const nameIndex = new Map();
  rows.forEach((r, index) => {
    const id = eventId_(r[12]);
    if (id) idIndex.set(id, index);
    const key = exactKey_(r[1], r[3], r[4]);
    if (!nameIndex.has(key)) nameIndex.set(key, []);
    nameIndex.get(key).push(index);
  });

  const sourceMap = new Map();
  for (const src of body.sources) {
    if (!SOURCES.includes(src.source) || sourceMap.has(src.source)) continue;
    sourceMap.set(src.source, src);
  }
  const touched = new Set();
  const newTouched = new Set();
  const seenThisPoll = new Map(SOURCES.map(src => [src, new Set()]));
  let created = 0;
  let addedObservations = 0;

  for (const source of SOURCES) {
    const info = sourceMap.get(source);
    if (!info || !Array.isArray(info.matches) || !['ÚSPĚCH', 'ČÁSTEČNĚ'].includes(info.status)) continue;
    if (info.matches.length > 3000) throw new Error('Unexpectedly large source list');
    for (const m of info.matches) {
      if (!m || !m.home || !m.away || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) continue;
      const srid = eventId_(m.eventId);
      const nameKey = exactKey_(m.date, m.home, m.away);
      let ix = srid && idIndex.has(srid) ? idIndex.get(srid) : -1;
      if (ix === -1) {
        const candidates = nameIndex.get(nameKey) || [];
        if (candidates.length === 1) ix = candidates[0];
      }
      if (ix === -1) {
        const key = [m.date, norm_(m.competition), normTeam_(m.home), normTeam_(m.away)].join('|');
        const initial = [key, m.date, m.competition || '', m.home, m.away,
          'NEOVĚŘENO', 'NEOVĚŘENO', 'NEOVĚŘENO', 'NEOVĚŘENO', stamp, stamp, 0,
          (srid ? srid : '') + (m.state ? '; ' + source + ': ' + m.state : '')];
        ix = rows.length;
        rows.push(initial);
        if (!nameIndex.has(nameKey)) nameIndex.set(nameKey, []);
        nameIndex.get(nameKey).push(ix);
        created++;
      }
      if (srid) {
        const old = eventId_(rows[ix][12]);
        if (!old) rows[ix][12] = (rows[ix][12] ? rows[ix][12] + '; ' : '') + srid;
        idIndex.set(srid, ix);
      }
      rows[ix][COL_BY_SOURCE[source]] = 'ANO';
      if (!seenThisPoll.get(source).has(ix)) {
        seenThisPoll.get(source).add(ix);
        addedObservations++;
      }
      rows[ix][10] = stamp;
      touched.add(ix);
      newTouched.add(ix);
    }
  }

  // Red means a proven absence, never failed extraction. This currently only
  // applies to a source explicitly verified as an exhaustive live feed.
  for (const source of SOURCES) {
    const info = sourceMap.get(source);
    if (!info || info.status !== 'ÚSPĚCH' || info.complete !== true) continue;
    const observed = seenThisPoll.get(source);
    for (const ix of newTouched) {
      if (!observed.has(ix) && rows[ix][COL_BY_SOURCE[source]] !== 'ANO') {
        rows[ix][COL_BY_SOURCE[source]] = 'NE';
        touched.add(ix);
      }
    }
  }
  for (const ix of newTouched) {
    rows[ix][11] = (Number(rows[ix][11]) || 0) + 1;
    touched.add(ix);
  }

  // Existing cells: write only touched rows. New cells: append in a single block.
  const oldCount = originalRows.length;
  for (const ix of touched) {
    if (ix < oldCount) gamesSheet.getRange(ix + 2, 1, 1, 13).setValues([rows[ix]]);
  }
  if (rows.length > oldCount) {
    gamesSheet.getRange(oldCount + 2, 1, rows.length - oldCount, 13)
      .setValues(rows.slice(oldCount));
  }

  function summaryStatus(source) {
    const entry = sourceMap.get(source);
    if (!entry) return {status: 'NEDOSTUPNÉ', count: ''};
    const valid = ['ÚSPĚCH', 'ČÁSTEČNĚ', 'NEDOSTUPNÉ'].includes(entry.status);
    const status = valid ? entry.status : 'NEDOSTUPNÉ';
    return {status, count: status === 'NEDOSTUPNÉ' ? '' : (entry.matches || []).length};
  }
  const counts = SOURCES.map(summaryStatus);
  checksSheet.appendRow([stamp, counts[0].status, counts[0].count, counts[1].status, counts[1].count,
    counts[2].status, counts[2].count, counts[3].status, counts[3].count,
    `${created} nových zápasů, ${addedObservations} dostupností; zdroje s neověřenou úplností nejsou použity k označení NE`]);
  srcSheet.getRange(2, 3, 4, 4).setValues(SOURCES.map((name, i) => {
    const s = sourceMap.get(name) || {};
    return [stamp, counts[i].status, counts[i].count, String(s.error || '').slice(0, 450)];
  }));
  return {ok: true, created, currentRows: rows.length, positiveObservations: addedObservations,
    sources: SOURCES.map((name, i) => ({name, ...counts[i]}))};
}