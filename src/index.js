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
let msgRef = null;
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
async function sendOrEdit(msg, ref) {
  if (ref && ref.chatId && ref.messageId) {
    try { await bot.telegram.editMessageText(ref.chatId, ref.messageId, null, msg, { parse_mode: 'MarkdownV2' }); return ref; } catch { }
  }
  if (grupo) {
    try { const s = await bot.telegram.sendMessage(grupo, msg, { parse_mode: 'MarkdownV2' }); return { chatId: grupo, messageId: s.message_id }; } catch { }
  }
  return null;
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
  if (dqg?.partidos?.length && (dqg.escrutinio?.estadoJornada==='Escrutada'||(dqg.escrutinio?.estadoJornada==='Cerrada'&&todosFin(dqg.partidos)))) { const p=await detectar('qg',JQG+1); if (p!==JQG) { JQG=p; c=true; console.log('QG→J'+JQG); msgRef=null; } }
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
  const W = 10;
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
      mi = (p.min || '').padStart(6);
    } else {
      const dd = (p.dia || '').slice(0, 3).toUpperCase();
      const hh = p.hora ? p.hora.slice(0, 2) : '';
      mi = (dd + hh).padStart(6);
    }
    const loc = pad(abv(p.loc, W), W);
    const vis = pad(abv(p.vis, W), W);
    const sc = ft || enVivo ? `${gL}-${gV}`.padStart(5) : '  -  ';
    const nStr = String(p.num).padStart(2);
    const liveEm = blink ? '🔴' : '🟢';
    const rt = enVivo ? `${liveEm}${nStr}` : `  ${nStr}`;
    l.push(`${rt}  ${loc} ${sc}  ${vis} ${mi}`);
  }
  let footer = `${v.length} partidos`;
  if (viv > 0) footer += `  🟢 ${viv}`;
  if (fin > 0) footer += `  🏁 ${fin}`;
  if (pre > 0) footer += `  ⏳ ${pre}`;
  l.push(footer);
  l.push('```');
  return l.join('\n');
}
function buildBoletoBlink(blink = false) {
  const bQ = fmtBoleto(prev, 'Quiniela', JQ, '⚽ QUINIELA', blink);
  const bQG = fmtBoleto(prev, 'Quinigol', JQG, '⚽ QUINIGOL', blink);
  return [bQ, bQG].filter(Boolean).join('\n\n');
}
function buildBoletoFrom(data, blink = false) {
  const bQ = fmtBoleto(data, 'Quiniela', JQ, '⚽ QUINIELA', blink);
  const bQG = fmtBoleto(data, 'Quinigol', JQG, '⚽ QUINIGOL', blink);
  return [bQ, bQG].filter(Boolean).join('\n\n');
}

// ── BLINK ──
function startBlink() {
  if (blinkTimer) return;
  blinkTimer = setInterval(async () => {
    blinkState = !blinkState;
    if (!msgRef || !grupo) return;
    const msg = buildBoletoBlink(blinkState);
    if (!msg) return;
    try {
      await bot.telegram.editMessageText(grupo, msgRef.messageId, null, msg, { parse_mode: 'MarkdownV2' });
      console.log('blink', blinkState ? '🟡' : '🟢');
    } catch (e) {
      if (e.description?.includes('message to edit not found') || e.code === 400) msgRef = null;
      else console.error('blink err:', e.description || e.message);
    }
  }, 1000);
  console.log('BLINK ON');
}
function stopBlink() {
  if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null; blinkState = false; console.log('BLINK OFF'); }
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
    if (todos.length && msg) {
      const s = await sendOrEdit(msg, msgRef);
      if (s) msgRef = s;
    }

    // Manage blink timer
    const hasLive = todos.some(p => p.estado === 'in');
    if (hasLive && !blinkTimer) startBlink();
    if (!hasLive && blinkTimer) stopBlink();

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
  ctx.reply(buildBoletoBlink(false), { parse_mode: 'MarkdownV2' });
});
bot.command('partidos', async (ctx) => {
  ctx.reply(buildBoletoBlink(false), { parse_mode: 'MarkdownV2' });
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
