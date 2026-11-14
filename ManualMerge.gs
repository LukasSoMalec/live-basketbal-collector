// Přidej jako NOVÝ soubor ManualMerge.gs do stávajícího Apps Script projektu.
// Neměň existující Code.gs a znovu nenasazuj webovou aplikaci.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Sloučit zápasy')
    .addItem('Ruční sloučení řádků…', 'manualMergeRows')
    .addToUi();
}

function manualMergeDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Europe/Prague', 'yyyy-MM-dd');
  }
  return String(value || '').trim().slice(0, 10);
}

function manualMergeStamp_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Europe/Prague', 'yyyy-MM-dd HH:mm:ss');
  }
  return String(value || '').trim().replace(/ (\d):/, ' 0$1:');
}

function manualMergeIds_(note) {
  // Synthetic sportsbook IDs containing 11111111 are not real SR IDs.
  return [...new Set(String(note || '').match(/sr:match:\d{5,}/gi) || [])]
    .map(id => id.toLowerCase())
    .filter(id => !id.slice('sr:match:'.length).includes('11111111'))
    .sort();
}

function manualMergeFootballIds_(note) {
  return [...new Set(Array.from(
    String(note || '').matchAll(/football:event:(sr:match:[a-zA-Z0-9|_-]{6,120})/g),
    m => m[1]
  ))].sort();
}

function manualMergeIdentity_(row) {
  return JSON.stringify([
    String(row[0]), manualMergeDate_(row[1]), String(row[2]),
    String(row[3]), String(row[4]),
    manualMergeIds_(row[12]), manualMergeFootballIds_(row[12])
  ]);
}

function manualMergeArchive_(ss, entries) {
  let archive = ss.getSheetByName('Archiv duplicit');
  if (!archive) archive = ss.insertSheet('Archiv duplicit');
  if (archive.getLastRow() === 0) {
    archive.getRange(1, 1, 1, 17).setValues([[
      'Čas sloučení', 'Klíč zachovaného zápasu', 'Původní řádek', 'Role',
      'Klíč zápasu', 'Datum utkání', 'Soutěž', 'Domácí', 'Hosté',
      'SynotTip', 'Fonbet', '1xBit', 'Football.com',
      'Poprvé', 'Naposledy', 'Počet kontrol', 'Poznámka'
    ]]);
    archive.setFrozenRows(1);
  }
  archive.getRange(archive.getLastRow() + 1, 1, entries.length, 17)
    .setValues(entries);
}

function manualMergeRows() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Zápasy');
  if (!sheet) return ui.alert('Chybí záložka Zápasy.');

  const input = ui.prompt(
    'Ruční sloučení zápasů',
    'Zadej čísla řádků, například 12, 27, 35. PRVNÍ řádek zůstane.',
    ui.ButtonSet.OK_CANCEL
  );
  if (input.getSelectedButton() !== ui.Button.OK) return;
  const answer = input.getResponseText().trim();
  if (!/^\d+(?:\s*[,;]\s*\d+)+$/.test(answer)) {
    return ui.alert('Použij například 12, 27, 35 (alespoň dva řádky).');
  }
  const numbers = answer.split(/\s*[,;]\s*/).map(Number);
  if (new Set(numbers).size !== numbers.length ||
      numbers.some(n => !Number.isSafeInteger(n) || n < 2 || n > sheet.getLastRow())) {
    return ui.alert('Čísla se nesmí opakovat a musí označovat existující datové řádky.');
  }

  const read = () => numbers.map(n => sheet.getRange(n, 1, 1, 13).getValues()[0]);
  const before = read();
  if (before.some(r => !r[0] || !r[3] || !r[4])) {
    return ui.alert('Některý zadaný řádek je prázdný nebo neúplný.');
  }
  if (new Set(before.map(r => manualMergeDate_(r[1]))).size !== 1) {
    return ui.alert('Nelze slučovat zápasy z různých dat.');
  }
  const uniqueIds = new Set(before.flatMap(r => manualMergeIds_(r[12])));
  if (uniqueIds.size > 1) {
    return ui.alert('STOP: Řádky obsahují různá SportRadar ID. Nic jsem nesloučil.');
  }
  const footballIds = new Set(before.flatMap(r => manualMergeFootballIds_(r[12])));
  if (footballIds.size > 1) {
    return ui.alert('STOP: Řádky obsahují různá ID utkání Football.com. Nic jsem nesloučil.');
  }

  const preview = numbers.map((n, i) =>
    (i === 0 ? 'PONECHAT ' : 'SMAZAT ') + n + ': ' +
    before[i][3] + ' – ' + before[i][4] + ' (' + before[i][2] + ')'
  ).join('\n');
  const confirmation = ui.alert(
    'Opravdu sloučit?',
    preview + '\n\nVšechna ANO zachovám, původní data uložím do Archivu duplicit.',
    ui.ButtonSet.YES_NO
  );
  if (confirmation !== ui.Button.YES) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return ui.alert('Právě probíhá jiný zápis. Zkus sloučení znovu.');
  }
  let report = '';
  try {
    const current = read();
    if (current.some((r, i) =>
      manualMergeIdentity_(r) !== manualMergeIdentity_(before[i]))) {
      throw new Error('Mezitím se změnil některý řádek. Zkus sloučení znovu.');
    }
    const merged = current[0].slice();

    for (let col = 5; col <= 8; col++) {
      const values = current.map(r => String(r[col] || '').trim());
      merged[col] = values.includes('ANO') ? 'ANO' :
        values.includes('NE') ? 'NE' : 'NEOVĚŘENO';
    }

    for (const [col, oldest] of [[9, true], [10, false]]) {
      const entries = current.map(r => r[col]).filter(v => manualMergeStamp_(v));
      entries.sort((a, b) =>
        manualMergeStamp_(a).localeCompare(manualMergeStamp_(b)));
      if (entries.length) merged[col] = oldest ? entries[0] : entries[entries.length - 1];
    }

    // Součet by mohl tutéž patnáctiminutovou kontrolu započítat několikrát.
    merged[11] = Math.max(...current.map(r => Number(r[11]) || 0));
    const notes = new Set();
    for (const row of current) {
      for (const part of String(row[12] || '').split(/\s*;\s*/)) {
        const note = part.trim();
        if (note && !note.startsWith('ZKONTROLOVAT DUPLIKAT')) notes.add(note);
      }
    }
    if (uniqueIds.size === 1 && ![...notes].some(t => t.includes([...uniqueIds][0]))) {
      notes.add([...uniqueIds][0]);
    }
    merged[12] = [...notes].join('; ');

    const stamp = Utilities.formatDate(new Date(), 'Europe/Prague', 'yyyy-MM-dd HH:mm:ss');
    const archiveRows = current.map((r, i) => [
      stamp, merged[0], numbers[i],
      i === 0 ? 'MASTER BEFORE' : 'MANUAL MERGED FROM', ...r
    ]);
    manualMergeArchive_(ss, archiveRows);

    // Měníme jen F:M, původní název, datum a klíč prvního řádku zůstávají.
    sheet.getRange(numbers[0], 6, 1, 8).setValues([merged.slice(5, 13)]);
    numbers.slice(1).sort((a, b) => b - a).forEach(n => sheet.deleteRow(n));
    report = 'Hotovo! Sloučeno ' + numbers.length + ' řádků do jednoho. Archiv je zachován.';
  } catch (error) {
    report = 'Sloučení nebylo dokončeno: ' + error.message;
  } finally {
    lock.releaseLock();
  }
  ui.alert(report);
}
