import { createServer } from 'http';
import { Telegraf } from 'telegraf';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TKN = process.env.TELEGRAM_BOT_TOKEN;
const TEMP = process.env.TEMPORADA || '2026';
const JQ = process.env.JORNADA_QUINIELA || '68';
const JQG = process.env.JORNADA_QUINIGOL || '78';
const INT = parseInt(process.env.POLL_INTERVAL) || 60;
const PORT = process.env.PORT || 8080;
const URL = 'https://livescore-bot-qpoh.onrender.com';
if (!TKN) { console.error('TELEGRAM_BOT_TOKEN no definido'); process.exit(1); }

const bot = new Telegraf(TKN);
const K = { reply_markup: { remove_keyboard: true } };
let admin = null, grupo = null;
const CFG = join(__dirname, '..', 'datos', 'config.json');
let prev = [];

function load() {
  try { if (existsSync(CFG)) { const d = JSON.parse(readFileSync(CFG,'utf-8')); admin = d.adminId; grupo = d.targetGroupId; } } catch {}
}
function save() {
  try { const d = join(__dirname,'..','datos'); if (!existsSync(d)) mkdirSync(d,{recursive:true}); writeFileSync(CFG,JSON.stringify({adminId:admin,targetGroupId:grupo})); } catch {}
}
load();

async function say(m) {
  if (grupo) try { await bot.telegram.sendMessage(grupo, m, K); } catch {}
  if (admin && admin !== grupo) try { await bot.telegram.sendMessage(admin, m, K); } catch {}
}

// ── HELPERS ──
function n(s) {
  return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').replace(/\s+/g,' ').trim();
}
function fix(t) {
  const w = ['real','fc','sd','ud','cd','cf','rc','sad','de','club','at','ath','vigo','r','b'];
  const p = t.split(' '); if (p.length<=1) return t;
  const f = p.filter(x=>!w.includes(x)).join(' '); return f.length?f:t;
}
const d2e = {
  'alemania':'germany','argelia':'algeria','belgica':'belgium','brasil':'brazil','camerun':'cameroon',
  'costa marfil':'ivory coast','croacia':'croatia','dinamarca':'denmark','escocia':'scotland',
  'eslovaquia':'slovakia','eslovenia':'slovenia','espana':'spain','francia':'france','gales':'wales',
  'grecia':'greece','inglaterra':'england','irlanda':'ireland','italia':'italy','japon':'japan',
  'marruecos':'morocco','nueva zelanda':'new zealand','paises bajos':'netherlands','polonia':'poland',
  'portugal':'portugal','rd congo':'congo dr','rdc':'congo dr','rumania':'romania','sudafrica':'south africa',
  'suecia':'sweden','suiza':'switzerland','tunez':'tunisia','turquia':'turkey','ucrania':'ukraine',
  'bosnia':'bosnia','bosnia herzegovina':'bosnia','rep checa':'czech republic','checa':'czech',
  'hungria':'hungary','corea del sur':'south korea','irlanda del norte':'northern ireland',
  'cabo verde':'cape verde','uzbekistan':'uzbekistan','ghana':'ghana','panama':'panama',
  'eeuu':'united states','usa':'united states','arabia saudi':'saudi arabia','turkiye':'turkey',
};
const ov = { 'ath club':'athletic','at madrid':'atletico','r madrid':'madrid','psg':'paris',
  'porto':'porto','oporto':'porto','friburgo':'freiburg','freiburg':'freiburg','celta':'celta',
  'leverkusen':'leverkusen','stuttgart':'stuttgart','lyon':'lyon','genk':'genk' };

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
    min:ev.status?.displayClock||"0'", est:ev.status?.type?.state||'pre', det:ev.status?.type?.shortDetail||'' };
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
function map(p,i,tipo) {
  const loc = typeof p.local==='object'?p.local.nombre:p.local;
  const vis = typeof p.visitante==='object'?p.visitante.nombre:p.visitante;
  const res = p.resultado||p.marcador||'-:-';
  const dia = tipo==='q'?p.dia:p.horario?.dia;
  const hora = tipo==='q'?p.hora:p.horario?.hora;
  let [gL,gV] = res!=='-:-'?res.split('-').map(Number):[null,null];
  const fin = p.estado?.includes('Finalizado')||p.estado?.includes('Escrutado')||(res!=='-:-'&&res!=='');
  const estado = fin?'post':(p.estado||'');
  return { idx:i, loc, vis, dia, hora, gL:isNaN(gL)?null:gL, gV:isNaN(gV)?null:gV, fin, estado };
}

// ── BOLETO ──
function ac(nombre, max=10) {
  return nombre.length>max?nombre.slice(0,max-1)+'…':nombre.padEnd(max);
}
function esc(g) {
  return g>=3?'M':String(g);
}
function boleto(todos, tipo, jornada, titulo) {
  const filtro = todos.filter(p=>p.tipo===tipo);
  if (!filtro.length) return '';
  let l = [`${titulo} J${jornada}`];
  l.push(`┌────┬──────────────────────┬───────┬────────┐`);
  l.push(`│ #  │ Partido              │ Goles │ Minuto │`);
  l.push(`├────┼──────────────────────┼───────┼────────┤`);
  for (const p of filtro) {
    const num = String(p.num).padStart(2);
    const loc = ac(p.loc,9);
    const vis = ac(p.vis,9);
    const ft = p.estado==='post'||p.fin;
    const enVivo = p.estado==='in';
    let gL = '-', gV = '-', min = '', emoji = '';
    if (ft) { gL = p.gL!==null?esc(p.gL):'-'; gV = p.gV!==null?esc(p.gV):'-'; min = 'FT'; emoji = '🏁'; }
    else if (enVivo) { gL = p.gL!==null?esc(p.gL):'0'; gV = p.gV!==null?esc(p.gV):'0'; min = p.min; emoji = '🟢'; }
    else { min = (p.dia||'')+(p.hora?' '+p.hora:''); }
    const gStr = `${gL}-${gV}`.padStart(5);
    const mStr = (min+' '+emoji).trim().padEnd(8);
    l.push(`│ ${num}│ ${loc}  │ ${gStr} │ ${mStr}│`);
    l.push(`│    │ ${vis}  │       │        │`);
    if (p!==filtro[filtro.length-1]) l.push(`├────┼──────────────────────┼───────┼────────┤`);
  }
  l.push(`└────┴──────────────────────┴───────┴────────┘`);
  return l.join('\n');
}

// ── MAIN ──
async function check() {
  try {
    const [ev, dQ, dQG] = await Promise.all([espn(), losilla('q',JQ), losilla('qg',JQG)]);
    const pq = dQ.map((p,i)=>map(p,i,'q'));
    const pqg = dQG.map((p,i)=>map(p,i,'qg'));

    const todos = [];
    for (const p of pq) {
      const m = match(p.loc, p.vis, ev, p.dia);
      const enVivo = m&&m.est==='in';
      const ft = p.fin||(m&&m.est==='post');
      const pre = !enVivo&&!ft;
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
      const pre = !enVivo&&!ft;
      todos.push({
        id: m?m.id:`qg-${p.idx}`, num: p.idx+1, tipo: 'Quinigol',
        loc: p.loc, vis: p.vis, dia: p.dia, hora: p.hora,
        gL: ft?(p.gL!==null?p.gL:(m?m.gL:null)):(enVivo?m.gL:null),
        gV: ft?(p.gV!==null?p.gV:(m?m.gV:null)):(enVivo?m.gV:null),
        min: enVivo?m.min:(ft?'FT':(p.dia+(p.hora?' '+p.hora:''))),
        estado: enVivo?'in':(ft?'post':'pre'), fin: ft,
      });
    }

    // Detect changes
    for (const p of todos) {
      if (p.estado==='pre') continue;
      const old = prev.find(e=>e.id===p.id);
      if (!old) continue;

      if (old.estado==='pre'&&p.estado==='in') {
        await say(`🟢 COMENZÓ [${p.tipo}] ${p.loc} vs ${p.vis}`);
      }
      if (p.estado==='in'&&old.estado!=='post') {
        const gA = p.gL||0, gB = p.gV||0, pA = old.gL||0, pB = old.gV||0;
        if (gA>pA) await say(`⚽ GOOOL de ${p.loc}! ${p.loc} ${gA}-${gB} ${p.vis} (${p.min})`);
        if (gB>pB) await say(`⚽ GOOOL de ${p.vis}! ${p.loc} ${gA}-${gB} ${p.vis} (${p.min})`);
      }
      if (p.estado==='post'&&old.estado!=='post') {
        await say(`🏁 FINAL [${p.tipo}] ${p.loc} ${p.gL}-${p.gV} ${p.vis}`);
      }
    }

    // Send boleto if changes detected
    const cambios = todos.some(p => {
      const old = prev.find(e=>e.id===p.id);
      return old && (old.estado!==p.estado||old.gL!==p.gL||old.gV!==p.gV);
    });
    if (cambios&&todos.length) {
      const bQ = boleto(todos,'Quiniela',JQ,'⚽ QUINIELA');
      const bQG = boleto(todos,'Quinigol',JQG,'⚽ QUINIGOL');
      await say([bQ,bQG].filter(Boolean).join('\n\n'));
    }

    if (!prev.length&&todos.length) {
      const bQ = boleto(todos,'Quiniela',JQ,'⚽ QUINIELA');
      const bQG = boleto(todos,'Quinigol',JQG,'⚽ QUINIGOL');
      await say([bQ,bQG].filter(Boolean).join('\n\n'));
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
  const bQ = boleto(prev,'Quiniela',JQ,'⚽ QUINIELA');
  const bQG = boleto(prev,'Quinigol',JQG,'⚽ QUINIGOL');
  ctx.reply([bQ,bQG].filter(Boolean).join('\n\n'), K);
});
bot.command('partidos', async (ctx) => {
  const bQ = boleto(prev,'Quiniela',JQ,'⚽ QUINIELA');
  const bQG = boleto(prev,'Quinigol',JQG,'⚽ QUINIGOL');
  ctx.reply([bQ,bQG].filter(Boolean).join('\n\n'), K);
});

// ── SERVER ──
createServer((req, res) => {
  if (req.method==='POST') { let b=''; req.on('data',c=>b+=c); req.on('end',async()=>{try{await bot.handleUpdate(JSON.parse(b))}catch{}}); res.end('OK'); return; }
  res.writeHead(200,{'Content-Type':'text/plain'}); res.end('OK');
}).listen(PORT,'0.0.0.0',()=>console.log(`:${PORT}`));

async function init() {
  await bot.telegram.setWebhook(URL);
  console.log('Webhook OK');
  await check();
  setInterval(check, INT*1000);
}
init().catch(e=>{console.error(e.message);process.exit(1);});
