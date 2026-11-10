// ==UserScript==
// @name         LIVE basketbal - kontrola a sloučení duplicit
// @namespace    live-basketbal-collector
// @version      1.2.0
// @author       LM
// @license      MIT
// @description  Bezpečný náhled a potvrzené sloučení duplicit v Google Sheets.
// @match        https://docs.google.com/spreadsheets/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==
(() => {
  'use strict';
  if (!location.pathname.includes('/d/1LWy7tTceA-kP_OMSlNRm1cLrzxAx0hMq4DI4pbzYOwI/')) return;
  if (document.getElementById('lm-auto-merge')) return;
  const style = document.createElement('style');
  style.textContent = [
    '#lm-auto-merge{position:fixed;right:18px;bottom:19px;z-index:999999;font:13px Arial,sans-serif;color:#f4f4f5}',
    '#lm-auto-merge *{box-sizing:border-box}',
    '#lm-auto-merge button{cursor:pointer;border:1px solid #52525b;border-radius:7px;padding:8px 12px;background:#27272a;color:#fafafa;font:inherit}',
    '#lm-auto-merge button:hover{background:#3f3f46}',
    '#lm-auto-merge button:disabled{opacity:.5;cursor:default}',
    '#lm-auto-merge .launch{background:#166534;border-color:#15803d;font-weight:700}',
    '#lm-auto-merge .panel{width:min(640px,calc(100vw - 36px));max-height:78vh;overflow:auto;background:#18181b;border:1px solid #52525b;border-radius:10px;box-shadow:0 8px 32px #0007;padding:15px;margin-bottom:10px}',
    '#lm-auto-merge .head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}',
    '#lm-auto-merge .head strong{font-size:15px}',
    '#lm-auto-merge .item{display:flex;gap:10px;border-top:1px solid #3f3f46;padding:10px 0;line-height:1.4}',
    '#lm-auto-merge .item input{flex:none;margin-top:3px}',
    '#lm-auto-merge .muted{color:#a1a1aa;font-size:12px}',
    '#lm-auto-merge .actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 0}',
    '#lm-auto-merge .good{color:#86efac}',
    '#lm-auto-merge .warn{color:#fcd34d}',
    '#lm-auto-merge .games{white-space:pre-line;padding:5px 0;font-size:12px}',
    '#lm-auto-merge .bad{color:#fca5a5}',
    '#lm-auto-merge .item:has(input:disabled){opacity:.65}'
  ].join('');
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'lm-auto-merge';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.style.display = 'none';
  const launch = document.createElement('button');
  launch.className = 'launch';
  launch.textContent = '🤖 AI PÁROVÁNÍ';
  root.append(panel, launch);
  document.body.appendChild(root);
  let proposals = [];
  let busy = false;

  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (label, onClick) => {
    const b = el('button', label);
    b.addEventListener('click', onClick);
    return b;
  };
  const validUrl = value => /^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/.test(value);
  function configure() {
    const oldUrl = GM_getValue('webapp_url', '');
    const url = prompt('URL stávající Apps Script webové aplikace (končí /exec):', oldUrl);
    if (url === null) return false;
    const cleanUrl = url.trim();
    if (!validUrl(cleanUrl)) {
      alert('Neplatná /exec URL webové aplikace.');
      return false;
    }
    const oldKey = GM_getValue('merge_key', '');
    const key = prompt('MERGE_KEY (samostatný klíč ze Script Properties; NE INGEST_KEY):', oldKey);
    if (key === null) return false;
    if (key.trim().length < 32) {
      alert('MERGE_KEY musí mít alespoň 32 znaků.');
      return false;
    }
    GM_setValue('webapp_url', cleanUrl);
    GM_setValue('merge_key', key.trim());
    return true;
  }
  function request(action, ids = [], attempt = 0) {
    const url = GM_getValue('webapp_url', '');
    const key = GM_getValue('merge_key', '');
    if (!validUrl(url) || !key) {
      if (!configure()) return Promise.reject(new Error('Chybí nastavení'));
      return request(action, ids, attempt);
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        data: JSON.stringify({action, key, ids}),
        timeout: 65000,
        onload(r) {
          try {
            const data = JSON.parse(r.responseText);
            // Jedině tento výsledek potvrzuje, že server sloučení vůbec
            // nezačal. Proto je opakování bezpečné i pro akci apply.
            if (data?.ok === false &&
                /^Locked; retry next run$/i.test(String(data.error || '').trim()) &&
                attempt < 3) {
              setTimeout(() => resolve(request(action, ids, attempt + 1)),
                3500 * (attempt + 1));
              return;
            }
            if (r.status >= 400 || data.ok !== true)
              throw new Error(data.error || 'HTTP ' + r.status);
            resolve(data);
          } catch (e) {
            reject(new Error('Apps Script: ' + e.message));
          }
        },
        onerror: () => reject(new Error('Síťová chyba při spojení s Apps Scriptem')),
        ontimeout: () => reject(new Error('Apps Script neodpověděl včas'))
      });
    });
  }
  function header() {
    panel.replaceChildren();
    const h = el('div', '', 'head');
    h.append(el('strong', 'Párování LIVE basketbalu'),
      button('🤖 AI fronta', aiPreview),
      button('Nastavení', () => configure()),
      button('✕', () => { panel.style.display = 'none'; }));
    panel.append(h);
  }
  function status(message, cls = 'muted') {
    const node = el('div', message, cls);
    panel.append(node);
    return node;
  }
  async function aiPreview() {
    if (busy) return;
    busy = true;
    panel.style.display = '';
    header();
    status('Načítám návrhy z listu AI sloučení…');
    try {
      const data = await request('aiMerge.preview');
      const groups = Array.isArray(data.proposals) ? data.proposals : [];
      const eligible = groups.filter(p => p.valid);
      const selected = new Set();
      header();
      status('Připraveno ' + data.auto + ' skupin SLOUČIT, ' +
        data.review + ' skupin PROVĚŘIT. Nedostupných po předchozím čištění: ' +
        (data.stale || 0) + '. Vyřízených: ' + data.processed + '.');
      status('Pouze výslovně označené skupiny se sloučí. Každá se před změnou ' +
        'ověří podle stabilních klíčů; originály se archivují. ' +
        'PROVĚŘIT vyžaduje tvoji kontrolu.');
      const actions = el('div', '', 'actions');
      const apply = button('Sloučit označené (0)', async () => {
        if (busy || !selected.size) return;
        const picked = groups.filter(p => selected.has(p.id));
        const uncertain = picked.filter(p => p.level === 'PROVĚŘIT').length;
        if (!confirm('Opravdu sloučit ' + picked.length + ' VYBRANÝCH skupin?' +
          (uncertain ? ' Mezi nimi je ' + uncertain +
          ' skupin označených PROVĚŘIT, které musíš mít ověřené!' : '') +
          ' Originální záznamy budou archivovány. ' +
          'Konfliktní nebo chybějící zápasy se nepřipojí.')) return;
        busy = true;
        apply.disabled = true;
        const totals = {groups:0, removed:0, blocked:0};
        let errors = '';
        try {
          const ids = picked.map(p => p.id);
          for (let i=0; i<ids.length; i+=3) {
            const batch = ids.slice(i,i+3);
            const res = await request('aiMerge.apply', batch);
            totals.groups += res.mergedGroups || 0;
            totals.removed += res.removedRows || 0;
            totals.blocked += res.blocked || 0;
            const progress = status('Zpracováno ' +
              Math.min(i+3, ids.length) + '/' + ids.length +
              ' skupin; spojeno ' + totals.groups + ', blokováno ' +
              totals.blocked + '.');
            progress.scrollIntoView({block:'nearest'});
          }
        } catch (e) {
          errors = e.message;
        } finally {
          busy = false;
        }
        alert('AI fronta: spojeno ' + totals.groups + ' skupin, odstraněno ' +
          totals.removed + ' duplicitních řádků, zablokováno ' +
          totals.blocked + '.' +
          (errors ? ' Běh se přerušil: ' + errors +
          '. Před dalším pokusem ověř stav v listu AI sloučení.' : ''));
        await aiPreview();
      });
      const update = () => {
        apply.textContent = 'Sloučit označené (' + selected.size + ')';
        apply.disabled = !selected.size;
      };
      actions.append(
        apply,
        button('Označit jistější', () => {
          for (const p of eligible) if (p.level === 'SLOUČIT') selected.add(p.id);
          for (const cb of panel.querySelectorAll('input[data-group]'))
            cb.checked = selected.has(cb.dataset.group);
          update();
        }),
        button('Odznačit vše', () => {
          selected.clear();
          for (const cb of panel.querySelectorAll('input[data-group]'))
            cb.checked = false;
          update();
        }),
        button('Obnovit', aiPreview)
      );
      panel.append(actions);
      if (data.removable > 0) {
        const clean = button('Vyřadit kombinované řádky s / (' +
          data.removable + ')', async () => {
          if (busy || !confirm('Archivovat a odstranit pouze umělé ' +
            'kombinované 1xBit řádky se dvěma nebo více zápasy?' +
            ' Tato operace je oddělená od spojování skupin.')) return;
          busy = true;
          clean.disabled = true;
          try {
            const res = await request('aiMerge.cleanComposites');
            alert('Archivováno a odstraněno: ' + res.removedRows +
              '. Zbývá: ' + res.remaining + '.');
          } catch (e) {
            alert('Nepodařilo se dokončit: ' + e.message);
          } finally {
            busy = false;
          }
          await aiPreview();
        });
        panel.append(clean);
      }
      if (!groups.length) status('Ve frontě už nejsou nevyřízené návrhy. ✅', 'good');
      for (const p of groups) {
        const line = el('label', '', 'item');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.group = p.id;
        cb.disabled = !p.valid;
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(p.id);
          else selected.delete(p.id);
          update();
        });
        const desc = el('div');
        desc.append(el('div', p.id + ' • ' + p.date +
          ' • ' + (p.level === 'SLOUČIT' ? 'JISTĚJŠÍ' : 'PROVĚŘIT') +
          ' • ' + p.size + ' řádky',
          p.valid ? (p.level === 'SLOUČIT' ? 'good' : 'warn') : 'bad'));
        desc.append(el('div', p.matches || '(bez popisu)', 'games'));
        desc.append(el('div', p.reason || '', 'muted'));
        if (!p.valid)
          desc.append(el('div', 'NEDOSTUPNÉ: ' + p.problem, 'bad'));
        line.append(cb, desc);
        panel.append(line);
      }
      update();
    } catch (e) {
      header();
      status(e.message, 'warn');
      status('Zkontroluj URL, MERGE_KEY a novou verzi nasazení Apps Scriptu.');
      panel.append(button('Zkusit znovu', aiPreview));
    } finally {
      busy = false;
    }
  }
  async function preview() {
    if (busy) return;
    busy = true;
    panel.style.display = '';
    header();
    status('Načítám návrhy…');
    try {
      const data = await request('autoMerge.preview');
      proposals = data.proposals || [];
      header();
      status('V tabulce: ' + data.totalRows + ' zápasů. Bezpečné shody: ' +
        data.safe + ', k prověření: ' + data.review + '.');
      if (!proposals.length) {
        status('Nic k sloučení. 😊', 'good');
        return;
      }
      const selected = new Set(proposals.filter(x => x.level === 'safe').map(x => x.id));
      const actionBar = el('div', '', 'actions');
      const apply = button('Sloučit vybrané (' + selected.size + ')', async () => {
        if (busy || !selected.size) return;
        if (!confirm('Opravdu sloučit ' + selected.size +
          ' návrhů? Původní řádky zůstanou v Archivu duplicit.')) return;
        busy = true;
        apply.disabled = true;
        try {
          const result = await request('autoMerge.apply', [...selected]);
          alert('Sloučeno: ' + result.merged + ' řádků. Archivováno: ' +
            result.archived + ' záznamů.');
          await previewAfterApply();
        } catch (e) {
          alert(e.message);
        } finally {
          busy = false;
          apply.disabled = false;
        }
      });
      const update = () => {
        apply.textContent = 'Sloučit vybrané (' + selected.size + ')';
        apply.disabled = !selected.size;
      };
      actionBar.append(apply, button('Znovu načíst', preview));
      panel.append(actionBar);
      for (const p of proposals) {
        const line = el('label', '', 'item');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(p.id);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(p.id);
          else selected.delete(p.id);
          update();
        });
        const desc = el('div');
        desc.append(el('div', (p.level === 'safe' ? '✅ JISTĚJŠÍ ' : '⚠️ OVĚŘIT ') +
          'ř. ' + p.masterRow + ' ← ' + p.removedRow +
          (p.reversed ? ' (prohozené týmy)' : ''),
          p.level === 'safe' ? 'good' : 'warn'));
        desc.append(el('div', p.master));
        desc.append(el('div', p.duplicate + ' (' + p.otherLeague + ')', 'muted'));
        desc.append(el('div', p.reason + ' • ' + p.date, 'muted'));
        line.append(cb, desc);
        panel.append(line);
      }
      update();
    } catch (e) {
      header();
      status(e.message, 'warn');
      panel.append(button('Znovu načíst', preview));
    } finally {
      busy = false;
    }
  }
  async function previewAfterApply() {
    busy = false;
    await preview();
  }
  launch.addEventListener('click', () => {
    if (panel.style.display === 'none') aiPreview();
    else panel.style.display = 'none';
  });
})();
