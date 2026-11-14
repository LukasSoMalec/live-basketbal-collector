// Read-only duplicate candidate discovery. Does NOT merge sheet rows.
// Input matches: [{n: GoogleSheetRowNumber, r: A:M array}]
// Input aliases: [{r: A:H array}], exact confirmed mappings only.
function discoverDuplicateCandidates(matches, aliases, api) {
  const sources=['SynotTip','Fonbet','1xBit','Football.com'];
  const normal=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
  const countries = [
    ['US','usa|united states|ncaa|wncaa|nba|wnba|g league'],
    ['IT','italie|italy|italia|serie a2|serie b'],
    ['FR','francie|france'],['DE','nemecko|germany|deutschland'],
    ['ES','spanelsko|spain|espana|acb|primera feb|segunda feb'],
    ['GR','recko|greece|greek|eska|eskana'],
    ['PT','portugalsko|portugal|portuguese|divisao'],
    ['PL','polsko|poland|polska'],['TR','turecko|turkey|turkiye|tb2l'],
    ['LT','litva|lithuania|nkl|lkl'],['LV','lotyssko|latvia'],
    ['EE','estonsko|estonia|estland'],['FI','finsko|finland|korisliiga'],
    ['SE','svedsko|sweden|basketligan'],['DK','dansko|denmark'],
    ['NO','norsko|norway'],['IS','island|iceland|urvalsdeild'],
    ['GB','anglie|british|england|scotland|united kingdom'],
    ['IE','irsko|ireland'],['RU','rusko|russia|vtb|united youth league'],
    ['UA','ukrajina|ukraine'],['BY','belorusko|belarus'],
    ['RS','srbsko|serbia'],['HR','chorvatsko|croatia'],
    ['BA','bosna|bosnia'],['SI','slovinsko|slovenia'],
    ['SK','slovensko|slovakia'],['CZ','cesko|czech|czechia'],
    ['HU','madarsko|hungary'],['RO','rumunsko|romania'],
    ['BG','bulharsko|bulgaria'],['ME','cerna hora|montenegro'],
    ['AT','rakousko|austria'],['CH','svycarsko|switzerland|swiss'],
    ['NL','nizozemsko|netherlands|holland'],['BE','belgie|belgium'],
    ['IL','izrael|israel'],['LB','libanon|lebanon'],
    ['QA','katar|qatar|qbl'],['SA','saudi|arabia'],
    ['EG','egypt'],['TN','tunisko|tunisia'],['DZ','alzirsko|algeria'],
    ['MA','maroko|morocco'],['AO','angola'],['NG','nigeria'],
    ['ZA','south africa|jizni afrika'],['KR','jizni korea|south korea|korea|wkbl|kbl'],
    ['JP','japonsko|japan|b league'],['CN','cina|china|cba|zba'],
    ['TW','taiwan'],['PH','filipiny|philippines|pba|uaap|pnl'],
    ['ID','indonesie|indonesia'],['MY','malajsie|malaysia'],
    ['TH','thajsko|thailand'],['VN','vietnam'],
    ['AU','australie|australia|wnbl'],['NZ','novy zeland|new zealand|tauihi'],
    ['BR','brazilie|brazil|brasil|nbb'],
    ['AR','argentina'],['UY','uruguay|tercera de ascenso'],
    ['PY','paraguay'],['CL','chile'],['PE','peru'],['EC','ekvador|ecuador'],
    ['CO','kolumbie|colombia'],['VE','venezuela'],
    ['MX','mexiko|mexico|cibapac'],['SV','salvador'],
    ['CR','kostarika|costa rica'],['PR','puerto rico|bsnf'],
    ['DO','dominicana|dominican'],
    ['INT','mezinarodni|international|eurocup|euroleague|euroliga|european|fiba|champions league|liga mistru|africa league|asian tournament|aba league']
  ].map(([code,terms])=>({code,re:new RegExp('\\b(?:'+terms+')\\b')}));
  function country(league) {
    const s=normal(league);
    if (/philippines|filipiny/.test(s))return 'PH'; // Philippines NCAA is NOT USA.
    for(const c of countries)if(c.re.test(s))return c.code;
    return '';
  }
  function stamp(s) {
    const t=String(s||'').trim().replace(/^(\d{4}-\d\d-\d\d)\s+(\d):/,'$1 0$2:');
    const n=Date.parse(t.replace(' ','T'));return Number.isFinite(n)?n:NaN;
  }
  const learned=new Map(),groups=new Map();
  for(const {r} of aliases) {
    if(String(r[7]||'').trim().toUpperCase()!=='ANO'||!r[0]||!r[1]||!r[2]||!r[3]||!r[4])continue;
    const key=[r[0],api.normLeague_(r[1]),api.normTeam_(r[2]),String(r[4])].join('|');
    const target=api.normTeam_(r[3]),scope=api.normLeague_(r[5]);
    if(!learned.has(key))learned.set(key,new Set());
    learned.get(key).add(target+'|'+scope);
    const lk=api.normLeague_(r[1]);
    if(!groups.has(lk))groups.set(lk,new Set());
    groups.get(lk).add(scope);
  }
  const stops=new Set(['basket','basketball','baskets','basketbol','bc','bk','club','kk','fc','team','university','universidad','college','pallacanestro','baloncesto','basquetebol','baloncesto','sport','sports','the','de','do','da','di','del','della','of','a','b','as','asd','s','us','new','w','women','woman','men','sr','stud','student','students']);
  const variants = (row,col) => {
    const r=row.r,cat=row.cls,v=new Set([api.normTeam_(r[col])]);
    for(let i=0;i<4;i++) {
      if(r[5+i]!=='ANO')continue;
      const key=[sources[i],api.normLeague_(r[2]),api.normTeam_(r[col]),cat].join('|');
      const targets=learned.get(key);
      if(targets?.size===1)v.add([...targets][0].split('|')[0]);
    }
    return [...v];
  };
  const normTeam=s=>normal(s).replace(/\biii\b/g,'3').replace(/\bii\b/g,'2').replace(/\bsolun\b/g,'thessaloniki').replace(/\bpraha\b/g,'prague').replace(/\bkoeln\b/g,'cologne').replace(/\bbasketbal\b/g,'basketball').replace(/\bpetersburg\b/g,'petersburg');
  const token=s=>normTeam(s).split(' ').filter(x=>x&&!stops.has(x));
  function similarity(a,b){
    const x=normTeam(a),y=normTeam(b);if(x===y)return 1;
    const A=token(x),B=token(y);if(!A.length||!B.length)return 0;
    const xx=new Set(A),yy=new Set(B),shared=[...xx].filter(z=>yy.has(z));
    const containment=shared.length/Math.min(xx.size,yy.size);
    const jaccard=shared.length/Math.max(xx.size,yy.size);
    const gram=t=>{const w=t.join('');return new Set(Array.from({length:Math.max(0,w.length-1)},(_,i)=>w.slice(i,i+2)))};
    const g1=gram(A),g2=gram(B),dice=2*[...g1].filter(z=>g2.has(z)).length/Math.max(1,g1.size+g2.size);
    let prefix=0;for(const w of A)for(const v of B)if(w.length>=4&&v.length>=4&&(w.startsWith(v)||v.startsWith(w)))prefix=Math.max(prefix,Math.min(w.length,v.length)/Math.max(w.length,v.length));
    const partial=shared.length===1&&Math.min(xx.size,yy.size)===1&&shared[0].length>=5?.83:0;
    return Math.min(.99,Math.max(containment*.48+jaccard*.37+dice*.15,dice*.91,prefix*.67,partial));
  }
  function best(v,w){let max=0;for(const a of v)for(const b of w)max=Math.max(max,similarity(a,b));return max}
  function category(r) {
    const detected=api.fixtureClass_(r[2],r[3],r[4]);
    const text=normal([r[2],r[3],r[4]].join(' '));
    const women=/\b(wkbl|wnbl|wnba|wncaa|bsnf|tauihi)\b/.test(text);
    return women?detected.split('|')[0]+'|women':detected;
  }
  const all=[];
  for(const m of matches){
    const r=m.r,cls=category(r);
    all.push({...m,cls,date:String(r[1]||'').slice(0,10),country:country(r[2]),time:stamp(r[9]),sources:sources.filter((_,i)=>r[5+i]==='ANO'),
      sr:api.eventId_(r[12]),opaque:api.rowFootballOpaqueId_(r[12]),vH:null,vA:null});
  }
  for(const r of all){r.vH=variants(r,3);r.vA=variants(r,4)}
  const buckets=new Map();
  for(const a of all){const key=a.date+'|'+a.cls;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(a)}
  const edges=[],sameKey=new Map(),compared={total:0,skipCountry:0,skipId:0};
  for(const rows of buckets.values())for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
    const a=rows[i],b=rows[j];compared.total++;
    const repeatKey=a.r[0]===b.r[0];
    if(repeatKey){
      if(!sameKey.has(a.r[0]))sameKey.set(a.r[0],new Set([a.n]));
      sameKey.get(a.r[0]).add(b.n);
      continue;
    }
    // "International" can be shared with country-specific names when teams agree.
    if(a.country&&b.country&&a.country!==b.country&&a.country!=='INT'&&b.country!=='INT'){compared.skipCountry++;continue}
    // Synthetic provider IDs starting with 11111111 are placeholders, not verified SR.
    const trustedA = a.sr && !/^sr:match:11111111\d+$/i.test(a.sr) ? a.sr : '';
    const trustedB = b.sr && !/^sr:match:11111111\d+$/i.test(b.sr) ? b.sr : '';
    if((trustedA && trustedB && trustedA !== trustedB) || (a.opaque && b.opaque && a.opaque !== b.opaque)) {compared.skipId++;continue}
    const s0=best(a.vH,b.vH),s1=best(a.vA,b.vA),r0=best(a.vH,b.vA),r1=best(a.vA,b.vH);
    const reversed=r0+r1>s0+s1;
    const scores=reversed?[r0,r1]:[s0,s1],min=Math.min(...scores),max=Math.max(...scores),avg=(scores[0]+scores[1])/2;
    const diff=Number.isFinite(a.time)&&Number.isFinite(b.time)?Math.round(Math.abs(a.time-b.time)/60000):9999;
    const common=a.sources.filter(z=>b.sources.includes(z)),complement=common.length===0;
    const idSame=!!(trustedA&&trustedA===trustedB||a.opaque&&a.opaque===b.opaque);
    const scopeA=api.normLeague_(a.r[2]),scopeB=api.normLeague_(b.r[2]);
    const leagueMatch=scopeA===scopeB||groups.get(scopeA)?.has(scopeB)||groups.get(scopeB)?.has(scopeA)||
      [...(groups.get(scopeA)||[])].some(x=>groups.get(scopeB)?.has(x));
    const sameCountry=a.country&&b.country&&a.country===b.country;
    const context=!!(sameCountry||leagueMatch||a.country==='INT'&&b.country==='INT');
    const sameT=diff===0,near=diff<=90,moderate=diff<=240;
    if(!idSame&&max<.28)continue;
    let rank=0;
    if(idSame)rank=5;
    else if(complement&&min>=.84&&avg>=.89&&(context||near))rank=4;
    else if(complement&&min>=.61&&avg>=.76&&context&&(near||avg>=.9))rank=3;
    else if(complement&&min>=.3&&avg>=.55&&context&&near)rank=2;
    else if(complement&&max>=.63&&min>=.12&&context&&sameT)rank=2;
    else if(complement&&min>=.2&&avg>=.43&&context&&sameT)rank=1;
    else if(complement&&min>=.47&&avg>=.7&&moderate&&context)rank=1;
    else if(complement&&min>=.75&&avg>=.85&&moderate)rank=1;
    else if(!complement&&min>=.68&&avg>=.84&&(near||leagueMatch))rank=1;
    else if(!complement&&min>=.45&&avg>=.76&&sameT&&leagueMatch)rank=1;
    else if(!context&&min>=.70&&avg>=.82&&near&&complement)rank=1;
    if(!rank)continue;
    if(!complement&&!idSame)rank=1;
    if(/\bbskt\s+cup\b/i.test(a.r[2]+' '+b.r[2])&&!idSame)rank=1;
    if((a.country==='INT')!==(b.country==='INT')&&!leagueMatch&&!idSame)rank=Math.min(rank,1);
    const names=[a.r[3]+' – '+a.r[4],b.r[3]+' – '+b.r[4]];
    edges.push({a:a.n,b:b.n,keyA:a.r[0],keyB:b.r[0],date:a.date,country:a.country||b.country||'',lgA:a.r[2],lgB:b.r[2],nameA:names[0],nameB:names[1],sH:+scores[0].toFixed(2),sA:+scores[1].toFixed(2),avg:+avg.toFixed(2),rank,diff,complement,common,sourceA:a.sources,sourceB:b.sources,idSame,srA:a.sr,srB:b.sr,reversed,
      numericScore:Math.round((avg*.72+(complement?.07:0)+(near?.04:0)+(context?.08:0)+(sameT?.03:0))*100)});
  }
  edges.sort((a,b)=>b.rank-a.rank||b.numericScore-a.numericScore);
  return {all,edges,sameKey:[...sameKey].map(([key,rows])=>({key,rows:[...rows]})),compared};
}
