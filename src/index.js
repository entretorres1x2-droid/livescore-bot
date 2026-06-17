import { createServer } from 'http';
import { Telegraf } from 'telegraf';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEMPORADA = process.env.TEMPORADA || '2026';
const J_Q = process.env.JORNADA_QUINIELA || '68';
const J_QG = process.env.JORNADA_QUINIGOL || '78';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 60;
const PORT = process.env.PORT || 8080;
const RENDER_URL = 'https://livescore-bot-qpoh.onrender.com';

if (!TELEGRAM_BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN no definido'); process.exit(1); }

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const sinTeclado = { reply_markup: { remove_keyboard: true } };
let adminId = null;
let targetGroupId = null;
const DATA_FILE = join(__dirname, '..', 'datos', 'config.json');
let estadoAnterior = []; // { id, golesLocal, golesVisitante, estado, local, visitante, tipo }

function loadData() {
  try {
    if (existsSync(DATA_FILE)) {
      const d = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
      adminId = d.adminId || null;
      targetGroupId = d.targetGroupId || null;
    }
  } catch {}
}
function saveData() {
  try {
    const dir = join(__dirname, '..', 'datos');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify({ adminId, targetGroupId }));
  } catch {}
}
loadData();

async function enviar(msg) {
  const opts = sinTeclado;
  if (targetGroupId) try { await bot.telegram.sendMessage(targetGroupId, msg, opts); } catch {}
  if (adminId && adminId !== targetGroupId) try { await bot.telegram.sendMessage(adminId, msg, opts); } catch {}
}

// ---- HELPERS ----
function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}
function fixName(t) {
  const stop = ['real','fc','sd','ud','cd','cf','rc','sad','de','club','at','ath','vigo','r','b'];
  const w = t.split(' ');
  if (w.length <= 1) return t;
  const f = w.filter(x => !stop.includes(x)).join(' ');
  return f.length > 0 ? f : t;
}
const esp2eng = {
  'alemania':'germany','argelia':'algeria','belgica':'belgium','brasil':'brazil','camerun':'cameroon',
  'costa marfil':'ivory coast','croacia':'croatia','dinamarca':'denmark','escocia':'scotland',
  'eslovaquia':'slovakia','eslovenia':'slovenia','espana':'spain','francia':'france','gales':'wales',
  'grecia':'greece','inglaterra':'england','irlanda':'ireland','italia':'italy','japon':'japan',
  'marruecos':'morocco','nueva zelanda':'new zealand','paises bajos':'netherlands','polonia':'poland',
  'portugal':'portugal','rd congo':'congo dr','congo dr':'congo dr','rdc':'congo dr',
  'rumania':'romania','sudafrica':'south africa','suecia':'sweden','suiza':'switzerland',
  'tunez':'tunisia','turquia':'turkey','ucrania':'ukraine','bosnia':'bosnia','bosnia herzegovina':'bosnia',
  'rep checa':'czech republic','checa':'czech','hungria':'hungary','corea del sur':'south korea',
  'corea del norte':'north korea','irlanda del norte':'northern ireland','islas feroe':'faroe islands',
  'cabo verde':'cape verde','uzbekistan':'uzbekistan','ghana':'ghana','panama':'panama',
  'eeuu':'united states','usa':'united states','arabia saudi':'saudi arabia','turkiye':'turkey',
};
const override = { 'ath club':'athletic', 'at madrid':'atletico', 'r madrid':'madrid', 'psg':'paris',
  'porto':'porto', 'oporto':'porto', 'friburgo':'freiburg', 'freiburg':'freiburg', 'celta':'celta',
  'leverkusen':'leverkusen', 'stuttgart':'stuttgart', 'lyon':'lyon', 'genk':'genk' };

function preparar(nombre) {
  const n = normalize(nombre);
  for (const [k,v] of Object.entries(override)) if (n.includes(k)) return v;
  return fixName(esp2eng[n] || n);
}
function contiene(team, target) {
  const c = s => normalize(s);
  if (c(team.displayName).includes(target) || c(team.shortDisplayName||'').includes(target) || c(team.abbreviation||'').includes(target)) return true;
  if (target.length >= 4 && c(team.displayName).includes(target.slice(0,4))) return true;
  const pals = target.split(' ').filter(w => w.length > 2);
  const clean = c(team.displayName);
  return pals.filter(w => clean.includes(w)).length >= Math.min(2, Math.ceil(pals.length/2));
}

// ---- APIS ----
async function getJSON(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'LiveScoreBot/1.0' } });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function obtenerEventosESPN() {
  const ahora = new Date();
  const fmt = d => d.toISOString().slice(0,10).replace(/-/g,'');
  const ini = fmt(new Date(ahora.getTime() - 4*864e5));
  const fin = fmt(new Date(ahora.getTime() + 2*864e5));
  const data = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${ini}-${fin}&limit=1000`);
  return data?.events || [];
}

function extraer(ev) {
  const c = ev.competitions?.[0];
  if (!c) return null;
  const home = c.competitors?.find(x => x.homeAway === 'home');
  const away = c.competitors?.find(x => x.homeAway === 'away');
  if (!home || !away) return null;
  return {
    id: ev.id, fecha: ev.date,
    home: home.team, away: away.team,
    gLocal: parseInt(home.score) || 0,
    gVisit: parseInt(away.score) || 0,
    minuto: ev.status?.displayClock || "0'",
    estado: ev.status?.type?.state || 'pre',
    detail: ev.status?.type?.shortDetail || '',
  };
}

function buscarMatch(local, visit, eventos, dia) {
  if (!dia) return null;
  const esFecha = dia.includes('/');
  let targetDia = null;
  if (!esFecha) targetDia = normalize(dia).toUpperCase().slice(0,3);
  const pLoc = preparar(local);
  const pVis = preparar(visit);
  if (pLoc.length < 2 || pVis.length < 2) return null;
  for (const ev of eventos) {
    const c = ev.competitions?.[0];
    if (!c) continue;
    if (!esFecha) {
      const dayEng = new Date(ev.date).toLocaleDateString('en-US', { weekday:'short', timeZone:'Europe/Madrid' });
      const map = { Sun:'DOM', Mon:'LUN', Tue:'MAR', Wed:'MIE', Thu:'JUE', Fri:'VIE', Sat:'SAB' };
      if (map[dayEng] !== targetDia) continue;
    }
    const home = c.competitors?.find(x => x.homeAway === 'home');
    const away = c.competitors?.find(x => x.homeAway === 'away');
    if (!home || !away) continue;
    if (contiene(home.team, pLoc) && contiene(away.team, pVis)) return extraer(ev);
    if (contiene(home.team, pVis) && contiene(away.team, pLoc)) return extraer(ev);
  }
  return null;
}

async function cargarLosilla(tipo, j) {
  const url = tipo === 'quiniela'
    ? `https://api.eduardolosilla.es/escrutinios?num_jornada=${j}&num_temporada=${TEMPORADA}`
    : `https://api.eduardolosilla.es/quinigol/escrutinios?temporada=${TEMPORADA}&jornada=${j}`;
  const data = await getJSON(url);
  return data?.partidos || [];
}

function mapear(p, i, tipo) {
  const loc = typeof p.local === 'object' ? p.local.nombre : p.local;
  const vis = typeof p.visitante === 'object' ? p.visitante.nombre : p.visitante;
  const resultado = p.resultado || p.marcador || '-:-';
  const dia = tipo === 'quiniela' ? p.dia : p.horario?.dia;
  const hora = tipo === 'quiniela' ? p.hora : p.horario?.hora;
  let [gL, gV] = resultado !== '-:-' ? resultado.split('-').map(Number) : [null, null];
  const finalizado = p.estado?.includes('Finalizado') || p.estado?.includes('Escrutado') || (resultado !== '-:-' && resultado !== '');
  return { idx: i, local: loc, visitante: vis, dia, hora, golesLocal: isNaN(gL) ? null : gL, golesVisitante: isNaN(gV) ? null : gV, finalizado, tipo };
}

// ---- MAIN LOOP ----
async function checkScores() {
  try {
    const [eventos, q1, qg] = await Promise.all([
      obtenerEventosESPN(),
      cargarLosilla('quiniela', J_Q),
      cargarLosilla('quinigol', J_QG),
    ]);
    const jornadaQ = q1.map((p,i) => mapear(p,i,'quiniela'));
    const jornadaQG = qg.map((p,i) => mapear(p,i,'quinigol'));

    const todos = [];
    for (const p of jornadaQ) {
      const m = buscarMatch(p.local, p.visitante, eventos, p.dia);
      todos.push({
        id: m ? m.id : `q-${p.idx}`,
        local: p.local, visitante: p.visitante,
        golesLocal: m ? m.gLocal : (p.finalizado ? p.golesLocal : null),
        golesVisitante: m ? m.gVisit : (p.finalizado ? p.golesVisitante : null),
        minuto: m ? m.minuto : (p.dia + ' ' + (p.hora||'')),
        estado: m ? m.estado : (p.finalizado ? 'post' : 'pre'),
        detalle: m ? m.detail : (p.finalizado ? 'FT' : 'Programado'),
        finalizado: p.finalizado || false,
        tipo: 'Quiniela',
      });
    }
    for (const p of jornadaQG) {
      const m = buscarMatch(p.local, p.visitante, eventos, p.dia);
      todos.push({
        id: m ? m.id : `qg-${p.idx}`,
        local: p.local, visitante: p.visitante,
        golesLocal: m ? m.gLocal : (p.finalizado ? p.golesLocal : null),
        golesVisitante: m ? m.gVisit : (p.finalizado ? p.golesVisitante : null),
        minuto: m ? m.minuto : (p.dia + ' ' + (p.hora||'')),
        estado: m ? m.estado : (p.finalizado ? 'post' : 'pre'),
        detalle: m ? m.detail : (p.finalizado ? 'FT' : 'Programado'),
        finalizado: p.finalizado || false,
        tipo: 'Quinigol',
      });
    }

    for (const p of todos) {
      if (p.estado === 'pre' && (p.golesLocal === null || p.golesVisitante === null)) continue;
      const prev = estadoAnterior.find(e => e.id === p.id);
      if (!prev) continue;

      // Inicio: pre -> in
      if (prev.estado === 'pre' && p.estado === 'in') {
        await enviar(`🟢 [${p.tipo}] COMENZÓ: ${p.local} vs ${p.visitante}`);
      }

      // Gol: cambio de marcador en estado 'in'
      if (p.estado === 'in' && prev.estado !== 'post') {
        const gA = p.golesLocal || 0, gB = p.golesVisitante || 0;
        const pA = prev.golesLocal || 0, pB = prev.golesVisitante || 0;
        if (gA > pA) await enviar(`⚽ [${p.tipo}] GOOOL de ${p.local}! ${p.local} ${gA}-${gB} ${p.visitante} (${p.minuto})`);
        if (gB > pB) await enviar(`⚽ [${p.tipo}] GOOOL de ${p.visitante}! ${p.local} ${gA}-${gB} ${p.visitante} (${p.minuto})`);
      }

      // Final: cualquier estado -> post
      if (p.estado === 'post' && prev.estado !== 'post') {
        await enviar(`🏁 [${p.tipo}] FINAL: ${p.local} ${p.golesLocal}-${p.golesVisitante} ${p.visitante}`);
      }
    }

    estadoAnterior = todos;
  } catch (err) {
    console.error('checkScores:', err.message);
  }
}

function formatearJornada() {
  if (estadoAnterior.length === 0) return 'Cargando jornada...';
  const q = estadoAnterior.filter(p => p.tipo === 'Quiniela');
  const qg = estadoAnterior.filter(p => p.tipo !== 'Quiniela');
  let msg = '📅 JORNADA\n';
  if (q.length > 0) {
    msg += '\n⚽ QUINIELA:\n' + q.map((p,i) => {
      const s = p.golesLocal !== null ? `${p.golesLocal}-${p.golesVisitante}` : '-:-';
      const m = p.estado === 'post' ? 'FT' : (p.estado === 'in' ? p.minuto : '');
      return `${i+1}. ${p.local} ${s} ${p.visitante}${m ? ' ('+m+')' : ''}`;
    }).join('\n');
  }
  if (qg.length > 0) {
    msg += '\n\n⚽ QUINIGOL:\n' + qg.map((p,i) => {
      const s = p.golesLocal !== null ? `${p.golesLocal}-${p.golesVisitante}` : '-:-';
      const m = p.estado === 'post' ? 'FT' : (p.estado === 'in' ? p.minuto : '');
      return `${i+1}. ${p.local} ${s} ${p.visitante}${m ? ' ('+m+')' : ''}`;
    }).join('\n');
  }
  return msg;
}

// ---- BOT ----
bot.on('my_chat_member', async (ctx) => {
  const u = ctx.myChatMember;
  if (!u) return;
  const chat = u.chat;
  if (chat.type === 'group' || chat.type === 'supergroup') {
    if (u.new_chat_member.status === 'member' || u.new_chat_member.status === 'administrator') {
      targetGroupId = chat.id;
      saveData();
      if (adminId) await bot.telegram.sendMessage(adminId, `✅ Grupo "${chat.title}" vinculado.`);
      await enviar('🤖 Bot activo. Aquí llegarán las notificaciones de la jornada.');
    }
  }
});

bot.start((ctx) => {
  adminId = ctx.chat.id;
  saveData();
  ctx.reply('✅ Bot activo. Añádeme a un grupo para recibir notificaciones en vivo de la jornada.', sinTeclado);
});

bot.command('jornada', async (ctx) => {
  ctx.reply(formatearJornada(), sinTeclado);
});
bot.command('partidos', async (ctx) => {
  ctx.reply(formatearJornada(), sinTeclado);
});

// ---- SERVER ----
createServer((req, res) => {
  if (req.url === '/' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try { await bot.handleUpdate(JSON.parse(body)); } catch {}
    });
    res.end('OK'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, '0.0.0.0', () => console.log(`Server :${PORT}`));

// ---- START ----
async function iniciar() {
  await bot.telegram.setWebhook(RENDER_URL);
  console.log('Webhook OK');
  console.log(`Poll cada ${POLL_INTERVAL}s`);
  await checkScores();
  setInterval(checkScores, POLL_INTERVAL * 1000);
}
iniciar().catch(e => { console.error('Error:', e.message); process.exit(1); });
