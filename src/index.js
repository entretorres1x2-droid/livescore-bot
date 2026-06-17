import { createServer } from 'http';
import { Telegraf, Markup } from 'telegraf';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config, { cargarJugadas } from './config.js';
import { obtenerPartidosEnVivo, detectarGolesNuevos, detectarEventosPartido } from './scorer.js';
import { resumenColumnas, detectarMuertas } from './analyzer.js';
import { generarComentarioGol, generarComentarioInicio, generarComentarioFinal, generarComentarioMuertas, generarComentarioEstado, generarComentarioIA } from './commentary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

let partidosAnteriores = [];
let adminId = null;
let targetGroupId = null;
let jugadas = cargarJugadas();
const DATA_FILE = join(__dirname, '..', 'datos', 'config.json');

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

async function enviar(msg, extra) {
  if (targetGroupId) {
    try { await bot.telegram.sendMessage(targetGroupId, msg, extra || {}); } catch {}
  }
  if (adminId) {
    try { await bot.telegram.sendMessage(adminId, msg, extra || {}); } catch {}
  }
}

function topColumnas(columnas, max = 5) {
  const vivas = columnas.filter(c => c.viva).sort((a, b) => b.maxPosible - a.maxPosible).slice(0, max);
  const lineas = ['```', ' #  │ Jugada         │ Act │ Max │', '────┼────────────────┼─────┼─────┤'];
  for (const c of vivas) {
    const n = String(c.num).padStart(2);
    const r = c.raw.length > 14 ? c.raw.slice(0, 14) : c.raw.padEnd(14);
    const act = String(c.aciertos).padStart(3);
    const max = c.viva ? `${c.maxPosible}✓`.padStart(4) : ' 💀';
    lineas.push(` ${n} │ ${r} │ ${act} │ ${max} │`);
  }
  lineas.push('```');
  return lineas.join('\n');
}

function formatearEstado(result) {
  const r = resumenColumnas(jugadas, result.quinigol);
  const lineas = [`📊 QUINIGOL`];
  lineas.push(generarComentarioEstado(r.vivas, r.muertas, r.maxCategoria));
  if (r.vivas > 0) lineas.push('\n' + topColumnas(r.columnas, 5));
  if (r.muertas > 0) {
    const muertas = r.columnas.filter(c => !c.viva).sort((a, b) => b.aciertos - a.aciertos).slice(0, 3);
    lineas.push(`\n💀 Últimas muertas: ${muertas.map(m => `#${m.num}(${m.aciertos} act)`).join(', ')}`);
  }
  return lineas.join('\n');
}

async function checkScores() {
  try {
    const result = await obtenerPartidosEnVivo();
    jugadas = cargarJugadas();
    if (!result || result.todos.length === 0) return;

    if (!partidosAnteriores || partidosAnteriores.length === 0) {
      partidosAnteriores = result.todos;
      const msg = formatearEstado(result);
      if (msg) await enviar(msg, { parse_mode: 'Markdown' });
      return;
    }

    const eventos = detectarEventosPartido(result.todos, partidosAnteriores);
    const goles = detectarGolesNuevos(result.todos, partidosAnteriores);
    if (eventos.inicio.length === 0 && eventos.final.length === 0 && goles.length === 0) return;

    const muertasNuevas = detectarMuertas(jugadas, partidosAnteriores, result.todos);
    const r = resumenColumnas(jugadas, result.quinigol);

    for (const p of eventos.inicio) {
      await enviar(generarComentarioInicio(p));
    }

    for (const gol of goles) {
      const impacto = { ...r, muertas: muertasNuevas };
      const msg = await generarComentarioIA(gol, impacto);
      await enviar(msg, { parse_mode: 'Markdown' });
    }

    for (const p of eventos.final) {
      await enviar(generarComentarioFinal(p));
    }

    if (eventos.inicio.length > 0 || eventos.final.length > 0 || goles.length > 0) {
      const estado = formatearEstado(result);
      if (estado) await enviar(estado, { parse_mode: 'Markdown' });
    }

    partidosAnteriores = result.todos;
  } catch (err) {
    console.error('checkScores error:', err.message);
  }
}

bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  if (!update) return;
  const chat = update.chat;
  if (chat.type === 'group' || chat.type === 'supergroup') {
    if (update.new_chat_member.status === 'member' || update.new_chat_member.status === 'administrator') {
      targetGroupId = chat.id;
      saveData();
      if (adminId) await bot.telegram.sendMessage(adminId, `Grupo "${chat.title}" vinculado. Notis irán allí.`);
    }
  }
});

bot.start((ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('Contrólame por privado @SS_Goles_bot');
  adminId = ctx.chat.id;
  saveData();
  const msg = `¡Bienvenido al Quinigol Bot!

Sube un .txt con tus columnas Quinigol (12 chars cada línea)
Ej: 012M1011M200

Después te notificaré aquí y en el grupo cada gol/evento.`;
  ctx.reply(msg);
});

bot.help((ctx) => ctx.reply(
  '/start - Bienvenida\n' +
  '/jugada - Subir archivo .txt con columnas\n' +
  '/vivas - Estado actual de las columnas\n' +
  '/jornada - Partidos de la jornada'
));

function kb(ctx) {
  return ctx.chat.type === 'private' ? Markup.removeKeyboard() : Markup.removeKeyboard();
}

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') return;
  return next();
});

bot.command('jugada', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  ctx.session = ctx.session || {};
  ctx.session.esperandoArchivo = true;
  ctx.reply('Envía el archivo .txt con las columnas Quinigol (12 chars cada línea).');
});

bot.command('vivas', async (ctx) => {
  const result = await obtenerPartidosEnVivo();
  const msg = formatearEstado(result);
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('jornada', async (ctx) => {
  const result = await obtenerPartidosEnVivo();
  if (result.quinigol.length === 0) return ctx.reply('No hay partidos de Quinigol ahora.');
  const msg = '⚽ JORNADA QUINIGOL\n' + result.quinigol.map(p => {
    const s = p.golesLocal !== null ? `${p.golesLocal}-${p.golesVisitante}` : '-:-';
    const m = p.minuto === '0\'' ? '' : ` (${p.minuto})`;
    return `${p.local} ${s} ${p.visitante}${m}`;
  }).join('\n');
  ctx.reply(msg);
});

bot.on('text', async (ctx) => {
  const s = ctx.session = ctx.session || {};
  if (s.esperandoArchivo) {
    s.esperandoArchivo = false;
    ctx.reply('Espera el archivo .txt. Usa 📎 > Archivo.');
  }
});

bot.on('document', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  try {
    const doc = ctx.message.document;
    if (!doc.file_name.endsWith('.txt')) return ctx.reply('Solo .txt');

    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const resp = await fetch(fileLink.href);
    const text = await resp.text();

    const lineas = text.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('//'));

    const validas = lineas.filter(l => l.length >= 12 && /^[012Mm]{12}$/.test(l));
    if (validas.length === 0) return ctx.reply('No se encontraron columnas Quinigol válidas (12 chars, solo 0/1/2/M).');

    const dir = join(__dirname, '..', 'datos');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'quinigol.txt'), validas.join('\n'), 'utf-8');
    jugadas = validas;

    await ctx.reply(`✅ ${validas.length} columnas cargadas.`);
    const result = await obtenerPartidosEnVivo();
    const estado = formatearEstado(result);
    if (estado) await enviar(estado, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply(`Error: ${err.message}`);
  }
});

const PORT = process.env.PORT || 8080;
const RENDER_URL = 'https://livescore-bot-qpoh.onrender.com';

createServer((req, res) => {
  if (req.url === '/' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try { await bot.handleUpdate(JSON.parse(body)); } catch {}
    });
    res.end('OK');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Server on port ${PORT}`);
});

async function iniciar() {
  await bot.telegram.setWebhook(RENDER_URL, { allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
  console.log('Webhook OK');
  console.log(`Iniciando polling cada ${config.POLL_INTERVAL}s...`);
  await checkScores();
  setInterval(checkScores, config.POLL_INTERVAL * 1000);
}

iniciar().catch(e => console.error('Error:', e.message));
