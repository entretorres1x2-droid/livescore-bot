import { createServer } from 'http';
import { Telegraf } from 'telegraf';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TKN = process.env.TELEGRAM_BOT_TOKEN;
const TEMP = process.env.TEMPORADA || '2026';
const INT = parseInt(process.env.POLL_INTERVAL) || 60;
const PORT = process.env.PORT || 8080;
const URL = 'https://livescore-bot-qpoh.onrender.com';
if (!TKN) { console.error('TELEGRAM_BOT_TOKEN no definido'); process.exit(1); }

const bot = new Telegraf(TKN);
const K = { reply_markup: { remove_keyboard: true } };
let admin = null, grupo = null;
const CFG = join(__dirname, '..', 'datos', 'config.json');
let prev = [];
let JQ = parseInt(process.env.JORNADA_QUINIELA) || 68;
let JQG = parseInt(process.env.JORNADA_QUINIGOL) || 78;
let msgRefs = {}; // { [chatId]: messageId }
let blinkState = false;
let blinkTimer = null;

function load() {
  try { if (existsSync(CFG)) { const d = JSON.parse(readFileSync(CFG,'utf-8')); admin = d.adminId; grupo = d.targetGroupId; JQ = d.jQ || JQ; JQG = d.jQG || JQG; } } catch {}
}
function save() {
  try { const d = join(__dirname,'..','datos'); if (!existsSync(d)) mkdirSync(d,{recursive:true}); writeFileSync(CFG,JSON.stringify({adminId:admin,targetGroupId:grupo,jQ:JQ,jQG:JQG})); } catch {}
}
load();

async function say(m) {
  if (grupo) try { await bot.telegram.sendMessage(grupo, m); } catch {}
  if (admin && admin !== grupo) try { await bot.telegram.sendMessage(admin, m); } catch {}
}
async function sendDeliver(msg, chatId) {
  try {
    const existing = msgRefs[chatId];
    if (existing) {
      try { await bot.telegram.editMessageText(chatId, existing, null, msg, { parse_mode: 'MarkdownV2' }); return; } catch (e) {
        const desc = e.description || '';
        // Only send new message if the existing one was deleted
        if (desc.includes('message to edit not found')) delete msgRefs[chatId];
        else return; // unchanged, rate limit, etc. — keep current ref
      }
    }
    const s = await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
    msgRefs[chatId] = s.message_id;
  } catch {}
}


// ── NORMALIZE ──
function n(s) {
  return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').replace(/\s+/g,' ').trim();
}
function fix(t) {
  const w = ['real','fc','sd','ud','cd','cf','rc','sad','de','club','at','ath','vigo','r','b'];
  const p = t.split(' '); if (p.length<=1) return t;
  const f = p.filter(x=>!w.includes(x)).join(' '); return f.length?f:t;
}
const d2e = {
  'alemania':'germany','inglaterra':'england','espana':'spain','francia':'france','portugal':'portugal',
  'rd congo':'congo dr','rdc':'congo dr','italia':'italy','suiza':'switzerland','bosnia':'bosnia',
  'bosnia herzegovina':'bosnia','rep checa':'czech republic','sudafrica':'south africa',
  'croacia':'croatia','ucrania':'ukraine','tunez':'tunisia','turquia':'turkey','turkiye':'turkey',
  'belgica':'belgium','brasil':'brazil','paises bajos':'netherlands','suecia':'sweden',
  'costa marfil':'ivory coast','marruecos':'morocco','japon':'japan','nueva zelanda':'new zealand',
  'egipto':'egypt','arabia saudi':'saudi arabia','uzbekistan':'uzbekistan','ghana':'ghana',
  'panama':'panama','hungria':'hungary','corea del sur':'south korea','escocia':'scotland',
  'eeuu':'united states','usa':'united states','cabo verde':'cape verde','gales':'wales',
  'dinamarca':'denmark','polonia':'poland','rumania':'romania','argelia':'algeria','camerun':'cameroon',
  'grecia':'greece','irlanda':'ireland','irlanda del norte':'northern ireland','islandia':'iceland',
  'noruega':'norway','serbia':'serbia','austria':'austria','paraguay':'paraguay','ecuador':'ecuador',
  'curazao':'curacao','iran':'iran','uruguay':'uruguay','argentina':'argentina','irak':'iraq',
  'almeria':'almeria','malaga':'malaga','haiti':'haiti','finlandia':'finland',
};
const ov = { 'ath club':'athletic','at madrid':'atletico','r madrid':'madrid','psg':'paris',
  'porto':'porto','friburgo':'freiburg','freiburg':'freiburg','celta':'celta','leverkusen':'leverkusen' };

function prep(nombre) {
  const a = n(nombre);
  for (const [k,v] of Object.entries(ov)) if (a.includes(k)) return v;
  return fix(d2e[a]||a);
}
function ctn(team, target) {
  const c = s => n(s);
  if (c(team.displayName).includes(target)||c(team.shortDisplayName||'').includes(target)||c(team.abbreviation||'').includes(target)) return true;
  if (target.length>=4&&c(team.displayName).includes(target.slice(0,4))) return true;
  const p = target.split(' ').filter(w=>w.length>2);
  return p.filter(w=>c(team.displayName).includes(w)).length >= Math.min(2,Math.ceil(p.length/2));
}

// ── APIS ──
async function jget(u) {
  try { const r = await fetch(u,{headers:{'User-Agent':'LSBot/1.0'}}); return r.ok?r.json():null; } catch { return null; }
}
async function espn() {
  const h = new Date();
  const f = d => d.toISOString().slice(0,10).replace(/-/g,'');
  const d = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${f(new Date(h.getTime()-4*864e5))}-${f(new Date(h.getTime()+2*864e5))}&limit=1000`);
  return d?.events||[];
}
function ext(ev) {
  const c = ev.competitions?.[0]; if (!c) return null;
  const h = c.competitors?.find(x=>x.homeAway==='home'), a = c.competitors?.find(x=>x.homeAway==='away');
  if (!h||!a) return null;
  return { id:ev.id, home:h.team, away:a.team, gL:parseInt(h.score)||0, gV:parseInt(a.score)||0,
    min:ev.status?.displayClock||"0'", est:ev.status?.type?.state||'pre' };
}
function match(loc, vis, eventos, dia) {
  if (!dia) return null;
  const esFecha = dia.includes('/'); let td = null;
  if (!esFecha) td = n(dia).toUpperCase().slice(0,3);
  const pLoc = prep(loc), pVis = prep(vis);
  if (pLoc.length<2||pVis.length<2) return null;
  for (const ev of eventos) {
    const c = ev.competitions?.[0]; if (!c) continue;
    if (!esFecha) {
      const de = new Date(ev.date).toLocaleDateString('en-US',{weekday:'short',timeZone:'Europe/Madrid'});
      const m = {Sun:'DOM',Mon:'LUN',Tue:'MAR',Wed:'MIE',Thu:'JUE',Fri:'VIE',Sat:'SAB'};
      if (m[de]!==td) continue;
    }
    const h = c.competitors?.find(x=>x.homeAway==='home'), a = c.competitors?.find(x=>x.homeAway==='away');
    if (!h||!a) continue;
    if (ctn(h.team,pLoc)&&ctn(a.team,pVis)) return ext(ev);
    if (ctn(h.team,pVis)&&ctn(a.team,pLoc)) return ext(ev);
  }
  return null;
}
async function losilla(tipo, j) {
  const u = tipo==='q'?`https://api.eduardolosilla.es/escrutinios?num_jornada=${j}&num_temporada=${TEMP}`
    :`https://api.eduardolosilla.es/quinigol/escrutinios?temporada=${TEMP}&jornada=${j}`;
  const d = await jget(u); return d?.partidos||[];
}

// ── JORNADA AUTO-DETECT ──
function tieneEquipos(partidos) {
  return partidos.some(p => { const l = typeof p.local==='object'?p.local.nombre:p.local; return l&&!l.includes('DETERMINAR'); });
}
function todosFin(partidos) {
  return partidos.length>0 && partidos.every(p => {
    const r = p.resultado||p.marcador||''; return p.estado==='Finalizado'||p.estado==='Escrutado'||(r!==''&&r!=='-:-'&&r!=='-');
  });
}
async function detectar(tipo, inicio) {
  for (let j=inicio; j<=inicio+50; j++) {
    const d = await jget(tipo==='q'?`https://api.eduardolosilla.es/escrutinios?num_jornada=${j}&num_temporada=${TEMP}`
      :`https://api.eduardolosilla.es/quinigol/escrutinios?temporada=${TEMP}&jornada=${j}`);
    if (!d?.partidos?.length||!tieneEquipos(d.partidos)) continue;
    if (tipo==='q') { if (d.estado==='ABIERTA') return j; if (d.estado!=='ESCRUTADA') return j; }
    else { const e = d.escrutinio?.estadoJornada; if (e==='Abierta') return j; if (e==='Cerrada'&&!todosFin(d.partidos)) return j; if (e==='Escrutada') continue; return j; }
  }
  for (let j=inicio-1; j>=Math.max(1,inicio-20); j--) {
    const d = await jget(tipo==='q'?`https://api.eduardolosilla.es/escrutinios?num_jornada=${j}&num_temporada=${TEMP}`
      :`https://api.eduardolosilla.es/quinigol/escrutinios?temporada=${TEMP}&jornada=${j}`);
    if (!d?.partidos?.length||!tieneEquipos(d.partidos)) continue;
    if (tipo==='q') { if (d.estado!=='ESCRUTADA') return j; }
    else { const e = d.escrutinio?.estadoJornada; if (e!=='Escrutada') return j; }
  }
  return inicio;
}
async function verificarAvance() {
  const [dq,dqg]=await Promise.all([jget(`https://api.eduardolosilla.es/escrutinios?num_jornada=${JQ}&num_temporada=${TEMP}`),jget(`https://api.eduardolosilla.es/quinigol/escrutinios?temporada=${TEMP}&jornada=${JQG}`)]);
  let c=false;
  if (dq?.partidos?.length && dq.estado==='ESCRUTADA' && todosFin(dq.partidos)) { const p=await detectar('q',JQ+1); if (p!==JQ) { JQ=p; c=true; console.log('Q→J'+JQ); } }
  if (dqg?.partidos?.length && (dqg.escrutinio?.estadoJornada==='Escrutada'||(dqg.escrutinio?.estadoJornada==='Cerrada'&&todosFin(dqg.partidos)))) { const p=await detectar('qg',JQG+1); if (p!==JQG) { JQG=p; c=true; console.log('QG→J'+JQG); msgRefs={}; } }
  if (c) save();
}

// ── MAP ──
function map(p,i,tipo) {
  const loc = typeof p.local==='object'?p.local.nombre:p.local;
  const vis = typeof p.visitante==='object'?p.visitante.nombre:p.visitante;
  const res = p.resultado||p.marcador||'-:-';
  const noRes = res==='-:-'||res==='-'||res==='';
  let [gL,gV] = noRes?[null,null]:res.split('-').map(Number);
  const fin = p.estado?.includes('Finalizado')||p.estado?.includes('Escrutado')||!noRes;
  const dia = tipo==='q'?p.dia:p.horario?.dia;
  const hora = tipo==='q'?p.hora:p.horario?.hora;
  return { idx:i, loc, vis, dia, hora, gL:isNaN(gL)?null:gL, gV:isNaN(gV)?null:gV, fin, estado:fin?'post':'' };
}

// ── BOLETO ──
function abv(s, n) {
  if (s.length <= n) return s;
  const p = s.split(' ');
  if (p.length > 1 && p[0].length <= n) return p[0];
  return s.substring(0, n-1) + '.';
}
function pad(s, n) { s=String(s); return s.length>=n?s:s+' '.repeat(n-s.length); }
function fmtBoleto(todos, tipo, j, tit, blink) {
  const f = todos.filter(p => p.tipo === tipo);
  if (!f.length) return '';
  const v = f.filter(p => !p.loc.toUpperCase().includes('DETERMINAR'));
  if (!v.length) return '';
    const W = 9;
  const viv = v.filter(p => p.estado === 'in').length;
  const fin = v.filter(p => p.estado === 'post').length;
  const pre = v.length - viv - fin;
  const l = [];
  let h = `${tit} J${j}`;
  if (viv > 0) h += `  🟢 ${viv} en vivo`;
  if (fin === v.length) h += `  🏁 FINALIZADA`;
  l.push(h);
  l.push('```');
  for (const p of v) {
    const ft = p.estado === 'post' || p.fin;
    const enVivo = p.estado === 'in';
    let gL = '-', gV = '-', mi = '';
    if (ft) {
      gL = p.gL !== null ? String(p.gL) : '-';
      gV = p.gV !== null ? String(p.gV) : '-';
      mi = 'FT'.padStart(6);
    } else if (enVivo) {
      gL = p.gL !== null ? String(p.gL) : '0';
      gV = p.gV !== null ? String(p.gV) : '0';
      const raw = p.min || '';
      mi = raw.includes('+') ? `➕${raw}` : raw;
      mi = mi.padStart(6);
    } else {
      const dd = (p.dia || '').slice(0, 3).toUpperCase();
      const hh = p.hora ? p.hora.slice(0, 2) : '';
      mi = (dd + hh).padStart(6);
    }
    const nStr = String(p.num).padStart(2);
    const rt = enVivo ? `🟢${nStr}` : `  ${nStr}`;
    if (enVivo && blink) {
      l.push(`${rt} ${' '.repeat(W)} ${' '.repeat(5)} ${' '.repeat(W)} ${' '.repeat(6)}`);
    } else {
      const loc = pad(abv(p.loc, W), W);
      const vis = pad(abv(p.vis, W), W);
      const sc = ft || enVivo ? `${gL}-${gV}`.padStart(5) : '  -  ';
      l.push(`${rt} ${loc} ${sc} ${vis} ${mi}`);
    }
  }
  let footer = `${v.length} partidos`;
  if (viv > 0) footer += `  🟢 ${viv}`;
  if (fin > 0) footer += `  🏁 ${fin}`;
  if (pre > 0) footer += `  ⏳ ${pre}`;
  l.push(footer);
  l.push('```');
  return l.join('\n');
}
function escMD(s) {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}
function appendEvents(body) {
  if (!lastEvent) return body;
  return body + '\n' + escMD(lastEvent);
}
function buildBoletoBlink(blink = false) {
  const bQ = fmtBoleto(prev, 'Quiniela', JQ, '⚽ QUINIELA', blink);
  const bQG = fmtBoleto(prev, 'Quinigol', JQG, '⚽ QUINIGOL', blink);
  return appendEvents([bQ, bQG].filter(Boolean).join('\n\n'));
}
function buildBoletoFrom(data, blink = false) {
  const bQ = fmtBoleto(data, 'Quiniela', JQ, '⚽ QUINIELA', blink);
  const bQG = fmtBoleto(data, 'Quinigol', JQG, '⚽ QUINIGOL', blink);
  return appendEvents([bQ, bQG].filter(Boolean).join('\n\n'));
}

// ── EVENTS ──
const knownEvents = new Map();
let lastEvent = null; // string — latest event shown under boleto
async function sayAnimated(frames, delay = 1800) {
  if (!grupo) return;
  try {
    const s = await bot.telegram.sendMessage(grupo, frames[0]);
    await new Promise(r => setTimeout(r, delay));
    await bot.telegram.editMessageText(grupo, s.message_id, null, frames[1]);
  } catch {}
}
const evIcons = {
  'Goal':'⚽','OwnGoal':'😱','YellowCard':'🟡','RedCard':'🔴','YellowRedCard':'🟡🔴',
  'Substitution':'🔄','ShotOnGoal':'💥','Miss':'❌','Save':'🧤','Penalty':'⚽',
  'ShootoutGoal':'✅','ShootoutMiss':'❌',
};
function tickerLine(d, pl, loc, vis, sc) {
  const min = d.clock.displayValue;
  const suf = pl ? `${pl} (${min})` : `(${min})`;
  const em = evIcons[d.type.text] || '•';
  const showScore = d.type.text === 'Goal' || d.type.text === 'OwnGoal' || d.type.text === 'Penalty';
  return showScore ? `${em} ${suf} · ${loc} ${sc} ${vis}` : `${em} ${suf}`;
}
function animateGoal(d, pl, loc, vis, sc) {
  return [
    `⚽⚽⚽⚽⚽ GOOOOOOL! ⚽⚽⚽⚽⚽`,
    tickerLine(d, pl||loc, loc, vis, sc),
  ];
}
function animateOwn(d, pl, loc, vis, sc) {
  return [
    `😱😱😱 GOL EN CONTRA! 😱😱😱`,
    tickerLine(d, pl||vis, loc, vis, sc),
  ];
}
function animateCard(title) {
  return (d, pl) => [
    `${title}`,
    tickerLine(d, pl),
  ];
}
const evMsg = {
  'Goal': animateGoal,
  'OwnGoal': animateOwn,
  'Penalty': animateCard('⚽ PENALTI ⚽'),
  'YellowCard': animateCard('🟡🟡 TARJETA AMARILLA 🟡🟡'),
  'RedCard': animateCard('🔴🔴🔴 TARJETA ROJA 🔴🔴🔴'),
  'YellowRedCard': animateCard('🟡🔴 EXPULSADO 🟡🔴'),
};
function getTicker(d, pl, loc, vis, sc) {
  const fn = evMsg[d.type.text];
  if (fn) return fn(d, pl, loc, vis, sc)[1]; // animated types use final frame
  return tickerLine(d, pl||loc, loc, vis, sc); // non-animated: just ticker
}
function detailKey(d) { return `${d.type.text}|${d.clock.displayValue}|${d.team.id}`; }
function playerName(d) {
  const a = d.athletesInvolved; if (!a || !a.length) return '';
  const subs = a.filter(x => x.displayName);
  return subs.length ? subs.map(x => x.displayName).join(', ') : '';
}
function getScoreStr(p) {
  const a = p.gL != null ? p.gL : 0;
  const b = p.gV != null ? p.gV : 0;
  return `${a}-${b}`;
}

// ── LIVE REFRESH ──
async function refreshLiveScores() {
  if (!prev.some(p => p.estado === 'in')) return;
  try {
    const ev = await espn();
    for (const p of prev) {
      if (p.estado !== 'in') continue;
      const m = match(p.loc, p.vis, ev, p.dia);
      if (!m) continue;
      // Fetch event detail for plays/cards/etc.
      const det = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard/${m.id}`);
      const details = det?.competitions?.[0]?.details || [];
      if (!knownEvents.has(p.id)) knownEvents.set(p.id, new Set());
      const seen = knownEvents.get(p.id);
      for (const d of details) {
        const k = detailKey(d);
        if (seen.has(k)) continue;
        seen.add(k);
        const pl = playerName(d);
        const sc = getScoreStr(p);
        const isAnim = !!evMsg[d.type.text];
        // Animated notification for goals/cards
        if (isAnim) {
          const frames = evMsg[d.type.text](d, pl, p.loc, p.vis, sc);
          await sayAnimated(frames, 2000);
        }
        // Update ticker under boleto (ALL types)
        lastEvent = getTicker(d, pl, p.loc, p.vis, sc);
      }
      if (m.est === 'post') {
        const gA = m.gL, gB = m.gV;
        p.estado = 'post'; p.fin = true; p.gL = gA; p.gV = gB; p.min = 'FT';
        await say(`🏁 FINAL [${p.tipo}] ${p.loc} ${gA}-${gB} ${p.vis}`);
      } else if (m.est === 'in') {
        const gA = m.gL, gB = m.gV, pA = p.gL || 0, pB = p.gV || 0;
        if (gA > pA) p.gL = gA;
        if (gB > pB) p.gV = gB;
        p.min = m.min;
      }
    }
  } catch (e) { console.error('refreshLiveScores:', e.message); }
}

// ── BLINK ──
let blinkTick = 0;
function startBlink() {
  if (blinkTimer) return;
  blinkTick = 0;
  let rate = 1000;
  const tick = async () => {
    if (!blinkTimer) return;
    blinkState = !blinkState;
    blinkTick++;
    if (blinkTick % 5 === 0) await refreshLiveScores();
    const msg = buildBoletoBlink(blinkState);
    if (!msg || !Object.keys(msgRefs).length) { stopBlink(); return; }
    let allFail = true;
    for (const cid of Object.keys(msgRefs)) {
      try { await bot.telegram.editMessageText(Number(cid), msgRefs[cid], null, msg, { parse_mode: 'MarkdownV2' }); allFail = false; } catch (e) {
        const desc = e.description || '';
        if (desc.includes('message to edit not found')) delete msgRefs[cid];
        else if (desc.includes('Too Many Requests')) allFail = true;
        else { allFail = false; console.error('blink err:', desc); }
      }
    }
    // Increase interval if rate limited
    if (allFail && rate < 10000) rate = Math.min(rate + 2000, 10000);
    else if (!allFail && rate > 1000) rate = Math.max(rate - 500, 1000);
    blinkTimer = setTimeout(tick, rate);
  };
  blinkTimer = setTimeout(tick, 100);
  console.log('BLINK ON');
}
function stopBlink() {
  if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null; blinkState = false; blinkTick = 0; console.log('BLINK OFF'); }
}

// ── MAIN ──
async function check() {
  try {
    await verificarAvance();
    const [ev, dQ, dQG] = await Promise.all([espn(), losilla('q',JQ), losilla('qg',JQG)]);
    const pq = dQ.map((p,i)=>map(p,i,'q'));
    const pqg = dQG.map((p,i)=>map(p,i,'qg'));

    const todos = [];
    for (const p of pq) {
      const m = match(p.loc, p.vis, ev, p.dia);
      const enVivo = m&&m.est==='in';
      const ft = p.fin||(m&&m.est==='post');
      todos.push({
        id: m?m.id:`q-${p.idx}`, num: p.idx+1, tipo: 'Quiniela',
        loc: p.loc, vis: p.vis, dia: p.dia, hora: p.hora,
        gL: ft?(p.gL!==null?p.gL:(m?m.gL:null)):(enVivo?m.gL:null),
        gV: ft?(p.gV!==null?p.gV:(m?m.gV:null)):(enVivo?m.gV:null),
        min: enVivo?m.min:(ft?'FT':(p.dia+(p.hora?' '+p.hora:''))),
        estado: enVivo?'in':(ft?'post':'pre'), fin: ft,
      });
    }
    for (const p of pqg) {
      const m = match(p.loc, p.vis, ev, p.dia);
      const enVivo = m&&m.est==='in';
      const ft = p.fin||(m&&m.est==='post');
      todos.push({
        id: m?m.id:`qg-${p.idx}`, num: p.idx+1, tipo: 'Quinigol',
        loc: p.loc, vis: p.vis, dia: p.dia, hora: p.hora,
        gL: ft?(p.gL!==null?p.gL:(m?m.gL:null)):(enVivo?m.gL:null),
        gV: ft?(p.gV!==null?p.gV:(m?m.gV:null)):(enVivo?m.gV:null),
        min: enVivo?m.min:(ft?'FT':(p.dia+(p.hora?' '+p.hora:''))),
        estado: enVivo?'in':(ft?'post':'pre'), fin: ft,
      });
    }

    // Event notifications
    for (const p of todos) {
      if (p.estado==='pre') continue;
      const old = prev.find(e=>e.id===p.id);
      if (!old) continue;
      if (old.estado==='pre'&&p.estado==='in') { await say(`🟢 COMENZÓ [${p.tipo}] ${p.loc} vs ${p.vis}`); }
      if (p.estado==='in'&&old.estado!=='post') {
        const gA=p.gL||0, gB=p.gV||0, pA=old.gL||0, pB=old.gV||0;
        if (gA>pA) { await say(`⚽ GOOOL de ${p.loc}! ${p.loc} ${gA}-${gB} ${p.vis} (${p.min})`); }
        if (gB>pB) { await say(`⚽ GOOOL de ${p.vis}! ${p.loc} ${gA}-${gB} ${p.vis} (${p.min})`); }
      }
      if (p.estado==='post'&&old.estado!=='post') { await say(`🏁 FINAL [${p.tipo}] ${p.loc} ${p.gL}-${p.gV} ${p.vis}`); }
    }

    // Update boleto (always edit, never send new)
    const msg = buildBoletoFrom(todos, blinkState);
    if (todos.length && msg && grupo) {
      await sendDeliver(msg, grupo);
    }

    // Manage blink timer
    const hasLive = todos.some(p => p.estado === 'in');
    if (hasLive && !blinkTimer) {
      startBlink();
      // Pin the boleto message while live matches exist
      if (grupo && msgRefs[grupo]) try { await bot.telegram.pinChatMessage(grupo, msgRefs[grupo]); } catch {}
    }
    if (!hasLive && blinkTimer) {
      stopBlink();
      // Unpin when no more live
      if (grupo && msgRefs[grupo]) try { await bot.telegram.unpinChatMessage(grupo, msgRefs[grupo]); } catch {}
    }

    prev = todos;
  } catch (e) { console.error('check:', e.message); }
}

// ── BOT ──
bot.on('my_chat_member', async (ctx) => {
  const u = ctx.myChatMember; if (!u) return;
  if (u.chat.type==='group'||u.chat.type==='supergroup') {
    if (u.new_chat_member.status==='member'||u.new_chat_member.status==='administrator') {
      grupo = u.chat.id; save();
      if (admin) await bot.telegram.sendMessage(admin, `✅ Grupo "${u.chat.title}" vinculado.`);
    }
  }
});
bot.start((ctx) => { admin = ctx.chat.id; save(); ctx.reply('✅ Bot activo. Añádeme a un grupo.', K); });
bot.command('jornada', async (ctx) => {
  await sendDeliver(buildBoletoBlink(false), ctx.chat.id);
});
bot.command('partidos', async (ctx) => {
  await sendDeliver(buildBoletoBlink(false), ctx.chat.id);
});

// ── SERVER ──
createServer((req, res) => {
  if (req.method==='POST') { let b=''; req.on('data',c=>b+=c); req.on('end',async()=>{try{await bot.handleUpdate(JSON.parse(b))}catch{}}); res.end('OK'); return; }
  res.writeHead(200,{'Content-Type':'text/plain'}); res.end('OK');
}).listen(PORT,'0.0.0.0',()=>console.log(`:${PORT}`));

async function init() {
  console.log('Detectando jornadas...');
  JQ = await detectar('q', JQ);
  JQG = await detectar('qg', JQG);
  console.log(`Quiniela J${JQ}, Quinigol J${JQG}`);
  save();
  await bot.telegram.setWebhook(URL);
  console.log('Webhook OK');
  await check();
  setInterval(check, INT*1000);
}
init().catch(e=>{console.error(e.message);process.exit(1);});
