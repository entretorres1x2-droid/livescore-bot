import { createServer } from 'http';
import { Telegraf, session, Markup } from 'telegraf';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { parsearMultiplesJugadas, parseQuinielaJugada, parseQuinigolJugada } from './parser.js';
import { obtenerPartidosEnVivo, detectarGolesNuevos, detectarEventosPartido, obtenerJornadaQuiniela, obtenerJornadaQuinigol, obtenerEventosESPN, verificarAvanceJornada, obtenerDatosPremios } from './scorer.js';
import { analizarImpacto, resumenJugadasVivas } from './analyzer.js';
import { generarComentarioIA, generarComentarioGol, generarComentarioVivas } from './commentary.js';
import { listarPenas, crearPena, eliminarPena, cargarJugadasPena, obtenerPena, escrutarPena, escrutarTodas } from './penas.js';
import { formatearRanking, formatearRankingCompacto } from './ranking.js';
import { formatearBoleto, formatearMejoresColumnas } from './boleto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
bot.use(session());

const MENU = Markup.keyboard([
  ['➕ Crear Peña', '📋 Peñas', '📊 Resumen'],
  ['⚽ Partidos', '📅 Jornada', '❌ Stop'],
]).resize();

let partidosAnteriores = [];
let chatIDs = new Set();
const DATA_FILE = join(__dirname, '..', 'datos', 'chats.json');

function loadChats() {
  try {
    if (existsSync(DATA_FILE)) {
      const d = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
      chatIDs = new Set(d.chats || []);
    }
  } catch {}
}

function saveChats() {
  try {
    if (!existsSync(join(__dirname, '..', 'datos'))) {
      mkdirSync(join(__dirname, '..', 'datos'), { recursive: true });
    }
    writeFileSync(DATA_FILE, JSON.stringify({ chats: [...chatIDs] }));
  } catch {}
}

loadChats();

function formatearEscrito(e) {
  const lineas = e.escrutinio.map(j =>
    `#${j.idx} ${j.raw} → ${j.aciertos} aciertos ${j.viva ? '✅' : '💀'}`
  );
  return lineas.join('\n');
}

function formatearCategorias(cat, total) {
  const lineas = [];
  for (let i = total; i >= 0; i--) {
    if (cat[i]?.count > 0) {
      lineas.push(`${i} aciertos: ${cat[i].count} jug. (pos: ${cat[i].positions.slice(0, 10).join(',')}${cat[i].positions.length > 10 ? '...' : ''})`);
    }
  }
  return lineas.join('\n');
}

async function checkScores() {
  try {
    const result = await obtenerPartidosEnVivo();
    if (!result || result.todos.length === 0) return;

    const eventos = detectarEventosPartido(result.todos, partidosAnteriores);
    const goles = detectarGolesNuevos(result.todos, partidosAnteriores);

    if (eventos.inicio.length === 0 && eventos.final.length === 0 && goles.length === 0) return;

    const premios = await obtenerDatosPremios();

    for (const p of eventos.inicio) {
      for (const chatId of chatIDs) {
        try { await bot.telegram.sendMessage(chatId, `🟢 COMENZÓ: ${p.local} vs ${p.visitante}`); } catch {}
      }
    }

    for (const p of eventos.final) {
      for (const chatId of chatIDs) {
        try { await bot.telegram.sendMessage(chatId, `🏁 FINAL: ${p.local} ${p.golesLocal}-${p.golesVisitante} ${p.visitante}`); } catch {}
      }
    }

    // Mostrar escrutinio y ranking tras cualquier evento
    for (const chatId of chatIDs) {
      await mostrarRanking(chatId, result, premios);
    }

    for (const gol of goles) {
      const infoGol = { ...gol };
      const impactoGlobal = analizarImpacto(
        infoGol, result.quiniela, result.quinigol,
        config.quinielaJugadas.map(j => parseQuinielaJugada(j)).filter(Boolean),
        config.quinigolJugadas.map(j => parseQuinigolJugada(j)).filter(Boolean)
      );
      const msgGlobal = await generarComentarioIA(infoGol, impactoGlobal);

      for (const chatId of chatIDs) {
        try { await bot.telegram.sendMessage(chatId, msgGlobal, { parse_mode: 'HTML' }); }
        catch (err) { if (err?.response?.error_code === 403) { chatIDs.delete(chatId); saveChats(); } }
      }

      for (const chatId of chatIDs) {
        await mostrarRanking(chatId, result, premios);
      }
    }

    partidosAnteriores = result.todos;
    await verificarAvanceJornada();
  } catch (err) {
    console.error('Error en checkScores:', err.message);
  }
}

async function mostrarRanking(chatId, result, premios) {
  try {
    const escrutinios = escrutarTodas(result.quiniela, result.quinigol);
    for (const e of escrutinios) {
      await bot.telegram.sendMessage(chatId, `📊 ${e.nombre}: ${e.vivas}✅ ${e.muertas}💀 de ${e.total}`);
    }
    const rkQ = formatearRankingCompacto('quiniela', result.quiniela, premios);
    const rkG = formatearRankingCompacto('quinigol', result.quinigol, premios);
    if (rkQ) await bot.telegram.sendMessage(chatId, `🏆 Quiniela:\n${rkQ}`);
    if (rkG) await bot.telegram.sendMessage(chatId, `🏆 Quinigol:\n${rkG}`);
  } catch {}
}

// ===== WIZARD: CREAR PEÑA =====
function iniciarWizard(ctx) {
  ctx.session = ctx.session || {};
  ctx.session.wizard = 'esperando_tipo';
  ctx.reply('¿De qué tipo es la peña?', Markup.inlineKeyboard([
    Markup.button.callback('🔵 Quiniela', 'wizard_tipo_quiniela'),
    Markup.button.callback('🟢 Quinigol', 'wizard_tipo_quinigol'),
    Markup.button.callback('❌ Cancelar', 'wizard_cancelar'),
  ]));
}

bot.action(/^wizard_tipo_(quiniela|quinigol)$/, (ctx) => {
  const tipo = ctx.match[1];
  ctx.session.wizard = 'esperando_nombre';
  ctx.session.wizardTipo = tipo;
  ctx.editMessageText(`Tipo: ${tipo}. Ahora escribe el nombre de la peña:`);
});

bot.action('wizard_cancelar', (ctx) => {
  ctx.session.wizard = null;
  ctx.editMessageText('Cancelado.');
});

bot.action(/^wizard_cargar_(.+)$/, async (ctx) => {
  const nombre = ctx.match[1];
  ctx.session.esperandoPena = nombre;
  ctx.editMessageText(`OK, envía el archivo .txt para "${nombre}".`);
});

bot.action(/^wizard_nocargar_(.+)$/, (ctx) => {
  const nombre = ctx.match[1];
  ctx.session.wizard = null;
  ctx.editMessageText(`✅ Peña "${nombre}" creada. Puedes cargar jugadas después con /cargar_pena ${nombre}.`);
});

// ===== COMANDOS =====

bot.start((ctx) => {
  chatIDs.add(ctx.chat.id);
  saveChats();
  const isPrivate = ctx.chat.type === 'private';
  if (isPrivate) {
    ctx.reply(
      '¡Bienvenido al LiveScore Bot! ⚽\n\n' +
      'Te avisaré de cada gol y cómo afecta a tus peñas.\n\n' +
      'Usa el menú de abajo para navegar 👇',
      MENU
    );
  } else {
    ctx.reply(
      '✅ ¡LiveScore Bot activo en el grupo!\n\n' +
      'Recibiréis notificaciones de cada gol y cómo afecta al escrutinio.\n\n' +
      'Comandos disponibles:\n' +
      '/ranking - Clasificación de peñas\n' +
      '/resumen - Estado global\n' +
      '/partidos - En vivo\n' +
      '/jornada - APIs y estado\n' +
      '/penas - Listar peñas\n' +
      '/pena NOMBRE - Detalle de peña\n' +
      '/stop - Dejar de recibir notis'
    );
  }
});

bot.help((ctx) => ctx.reply(
  '📋 Comandos:\n' +
  '/ranking - Ranking con premios estimados\n' +
  '/resumen - Estado global de peñas\n' +
  '/partidos - Partidos en vivo\n' +
  '/jornada - APIs y estado de la jornada\n' +
  '/penas - Listar todas las peñas\n' +
  '/pena NOMBRE - Detalle de una peña\n' +
  '/cargar_pena NOMBRE - Subir jugadas\n' +
  '/borrar_pena NOMBRE - Borrar peña\n' +
  '/boleto PEÑA # - Ver boleto visual\n' +
  '/stop - Darse de baja de notis',
  ctx.chat.type === 'private' ? MENU : Markup.removeKeyboard()
));

// ===== FUNCIONES REUTILIZABLES =====

async function generarJornada() {
  let msg = `📅 Temporada ${config.TEMPORADA}\n`;
  const peñas = listarPenas();
  msg += `Peñas: ${peñas.length}\n\n`;

  try {
    const [jornadaQL, jornadaQGL, eventos, result] = await Promise.all([
      obtenerJornadaQuiniela(), obtenerJornadaQuinigol(),
      obtenerEventosESPN(), obtenerPartidosEnVivo(),
    ]);

    msg += `📅 Quiniela: ${jornadaQL.length} | Quinigol: ${jornadaQGL.length}\n`;
    msg += `📡 ESPN: ${eventos.length} | Emparejados: ${result.quiniela.length} Q, ${result.quinigol.length} QG\n`;

    if (jornadaQL.length > 0) {
      msg += '\n⚽ Quiniela:\n' + jornadaQL.slice(0, 5).map(p =>
        `${p.local} - ${p.visitante} [${p.marcador}]`
      ).join('\n') + (jornadaQL.length > 5 ? `\n... y ${jornadaQL.length - 5} más` : '');
    }
    if (jornadaQGL.length > 0) {
      msg += '\n\n⚽ Quinigol:\n' + jornadaQGL.slice(0, 5).map(p =>
        `${p.local} - ${p.visitante} [${p.marcador}]`
      ).join('\n') + (jornadaQGL.length > 5 ? `\n... y ${jornadaQGL.length - 5} más` : '');
    }
    if (result.quiniela.length > 0) {
      msg += '\n\n🔴 En directo:\n' + result.quiniela.map(p => {
        const s = p.golesLocal !== null ? `${p.golesLocal}-${p.golesVisitante}` : '-:-';
        return `${p.local} ${s} ${p.visitante} (${p.minuto})`;
      }).join('\n');
    }
  } catch (e) { msg += `\n❌ Error: ${e.message}`; }
  return msg;
}

async function generarListaPenas() {
  const lista = listarPenas();
  if (lista.length === 0) return 'No hay peñas. Pulsa "➕ Crear Peña".';
  const result = await obtenerPartidosEnVivo();
  return '📊 PEÑAS\n\n' + lista.map(p => {
    const e = escrutarPena(p.nombre, p.tipo === 'quiniela' ? result.quiniela : result.quinigol);
    return e ? `${p.nombre} (${p.tipo}): ${e.vivas}✅ ${e.muertas}💀 de ${e.total}` : `${p.nombre}: sin datos`;
  }).join('\n');
}

async function generarResumen() {
  const result = await obtenerPartidosEnVivo();
  const jugQ = config.quinielaJugadas.map(j => parseQuinielaJugada(j)).filter(Boolean);
  const jugG = config.quinigolJugadas.map(j => parseQuinigolJugada(j)).filter(Boolean);

  let msg = '';
  if (jugQ.length > 0 || jugG.length > 0) {
    const vivas = resumenJugadasVivas(result.quiniela, result.quinigol, jugQ, jugG);
    msg = generarComentarioVivas(vivas.quiniela.length, vivas.quinigol.length) + '\n\n';
  }

  const peñas = listarPenas();
  if (peñas.length > 0) {
    msg += '📊 Peñas:\n' + peñas.map(p => {
      const e = escrutarPena(p.nombre, p.tipo === 'quiniela' ? result.quiniela : result.quinigol);
      return e ? `${p.nombre}: ${e.vivas}✅ ${e.muertas}💀 (${e.total})` : `${p.nombre}: sin datos`;
    }).join('\n');
  }
  return msg || 'No hay jugadas ni peñas. Pulsa "➕ Crear Peña".';
}

async function generarPartidos() {
  const result = await obtenerPartidosEnVivo();
  if (result.todos.length === 0) return 'No hay partidos ahora.';
  return '📺 Partidos:\n\n' + result.todos.map(p => {
    const s = p.golesLocal !== null ? `${p.golesLocal}-${p.golesVisitante}` : '-:-';
    return `${p.local} ${s} ${p.visitante} (${p.minuto})`;
  }).join('\n');
}

// ===== COMANDOS =====

function kb(ctx) {
  return ctx.chat.type === 'private' ? MENU : Markup.removeKeyboard();
}

// Middleware: solo admins en grupos
bot.use(async (ctx, next) => {
  const tipo = ctx.chat?.type;
  if (tipo === 'group' || tipo === 'supergroup') {
    if (ctx.message?.text?.startsWith('/')) {
      try {
        const member = await ctx.getChatMember(ctx.from.id);
        if (member.status !== 'administrator' && member.status !== 'creator') {
          return ctx.reply('⛽ Solo administradores del grupo pueden usar comandos.', kb(ctx));
        }
      } catch {
        // Si falla la consulta, permitimos
      }
    }
  }
  return next();
});

bot.command('jornada', async (ctx) => ctx.reply(await generarJornada(), kb(ctx)));
bot.command('penas', async (ctx) => ctx.reply(await generarListaPenas(), kb(ctx)));
bot.command('resumen', async (ctx) => ctx.reply(await generarResumen(), kb(ctx)));
bot.command('partidos', async (ctx) => ctx.reply(await generarPartidos(), kb(ctx)));

bot.command('pena', async (ctx) => {
  const nombre = ctx.message.text.slice('/pena'.length).trim();
  if (!nombre) {
    const lista = listarPenas();
    if (lista.length === 0) return ctx.reply('No hay peñas.', kb(ctx));
    return ctx.reply('Escribe /pena <nombre>\nPeñas: ' + lista.map(p => p.nombre).join(', '), kb(ctx));
  }
  const result = await obtenerPartidosEnVivo();
  const pena = obtenerPena(nombre);
  if (!pena) return ctx.reply('Peña no encontrada.', kb(ctx));

  // Escrutinio resumen
  const e = escrutarPena(nombre, pena.tipo === 'quiniela' ? result.quiniela : result.quinigol);
  let msg = '';
  if (e) {
    msg = `📊 ${e.nombre} (${e.tipo})\nTotal: ${e.total} | Vivas: ${e.vivas} | Muertas: ${e.muertas}\n\n`;
    msg += formatearCategorias(e.categorias, e.tipo === 'quiniela' ? 15 : 6);
  }

  // Mejores columnas
  const cols = formatearMejoresColumnas(nombre, pena.tipo === 'quiniela' ? result.quiniela : result.quinigol);
  if (cols.ok) msg += '\n\n' + cols.msg;

  ctx.reply(msg, kb(ctx));
});

bot.command('cargar_pena', async (ctx) => {
  const nombre = ctx.message.text.slice('/cargar_pena'.length).trim();
  if (!nombre) return ctx.reply('Uso: /cargar_pena <nombre>', kb(ctx));
  const pena = obtenerPena(nombre);
  if (!pena) return ctx.reply(`No existe "${nombre}".`, kb(ctx));
  ctx.session.esperandoPena = nombre;
  ctx.reply(`Envía el archivo .txt para "${nombre}" (${pena.tipo}).`, kb(ctx));
});

bot.command('borrar_pena', async (ctx) => {
  const nombre = ctx.message.text.slice('/borrar_pena'.length).trim();
  if (!nombre) {
    const lista = listarPenas();
    if (lista.length === 0) return ctx.reply('No hay peñas.', kb(ctx));
    return ctx.reply('Uso: /borrar_pena <nombre>\nPeñas: ' + lista.map(p => p.nombre).join(', '), kb(ctx));
  }
  const pena = obtenerPena(nombre);
  if (!pena) return ctx.reply(`No existe "${nombre}".`, kb(ctx));
  ctx.reply(
    `¿Seguro que quieres borrar la peña "${nombre}" (${pena.tipo})?`,
    Markup.inlineKeyboard([
      Markup.button.callback('✅ Sí, borrar', `borrar_${nombre}`),
      Markup.button.callback('❌ No', 'borrar_no'),
    ])
  );
});

bot.action(/^borrar_(.+)$/, async (ctx) => {
  const nombre = ctx.match[1];
  const res = eliminarPena(nombre);
  ctx.editMessageText(res.ok ? `✅ Peña "${nombre}" borrada.` : `❌ ${res.error}`);
});

bot.action('borrar_no', (ctx) => {
  ctx.editMessageText('Cancelado.');
});

bot.command('boleto', async (ctx) => {
  const args = ctx.message.text.slice('/boleto'.length).trim().split(/\s+/);
  const nombre = args.slice(0, -1).join(' ') || '';
  const num = parseInt(args[args.length - 1]);
  if (!nombre || isNaN(num)) return ctx.reply('Uso: /boleto NOMBRE_PEÑA NUMERO_JUGADA', kb(ctx));
  const result = await obtenerPartidosEnVivo();
  const partidos = obtenerPena(nombre)?.tipo === 'quiniela' ? result.quiniela : result.quinigol;
  if (!partidos) return ctx.reply('Peña no encontrada.', kb(ctx));
  const b = formatearBoleto(nombre, num, partidos);
  ctx.reply(b.msg, { parse_mode: 'Markdown', ...kb(ctx) });
});

bot.command('ranking', async (ctx) => {
  const [result, premios] = await Promise.all([obtenerPartidosEnVivo(), obtenerDatosPremios()]);
  const rkQ = formatearRanking('quiniela', result.quiniela, premios);
  const rkG = formatearRanking('quinigol', result.quinigol, premios);
  let msg = '';
  if (rkQ.includes('No hay')) msg += '❌ No hay peñas de quiniela.\n';
  else msg += rkQ + '\n';
  if (rkG.includes('No hay')) msg += '\n❌ No hay peñas de quinigol.';
  else msg += '\n' + rkG;
  ctx.reply(msg, kb(ctx));
});

bot.command('stop', (ctx) => {
  chatIDs.delete(ctx.chat.id);
  saveChats();
  ctx.reply('Dejaste de recibir notis. Usa /start para volver.', kb(ctx));
});

// ===== MANEJO DE MENSAJES (menú solo privado + wizard) =====

bot.on('text', async (ctx) => {
  const txt = ctx.message.text;
  const s = ctx.session = ctx.session || {};
  const isPrivate = ctx.chat.type === 'private';

  // En grupos ignorar texto que no sea comando
  if (!isPrivate && !txt.startsWith('/')) return;

  if (s.wizard === 'esperando_nombre') {
    const nombre = txt.trim();
    if (!nombre) return ctx.reply('Escribe un nombre válido.');
    const res = crearPena(nombre, s.wizardTipo);
    if (!res.ok) return ctx.reply(`❌ ${res.error}`);

    const tipo = s.wizardTipo;
    s.wizard = null;
    return ctx.reply(
      `✅ Peña "${nombre}" (${tipo}) creada.\n¿Quieres cargar jugadas ahora?`,
      Markup.inlineKeyboard([
        Markup.button.callback('📁 Sí, enviar archivo', `wizard_cargar_${nombre}`),
        Markup.button.callback('❌ No, después', `wizard_nocargar_${nombre}`),
      ])
    );
  }

  // Menú (solo en privado)
  if (isPrivate) {
    if (txt === '➕ Crear Peña') return iniciarWizard(ctx);
    if (txt === '📋 Peñas') return ctx.reply(await generarListaPenas(), MENU);
    if (txt === '📊 Resumen') return ctx.reply(await generarResumen(), MENU);
    if (txt === '⚽ Partidos') return ctx.reply(await generarPartidos(), MENU);
    if (txt === '📅 Jornada') return ctx.reply(await generarJornada(), MENU);
    if (txt === '❌ Stop') {
      chatIDs.delete(ctx.chat.id); saveChats();
      return ctx.reply('Dejaste de recibir notis. Usa /start para volver.', MENU);
    }
  }

  if (s.esperandoArchivo) ctx.reply('Envía el archivo .txt, no texto. Usa 📎 > Archivo.', MENU);
});

// ===== MANEJO DE ARCHIVOS =====

bot.on('document', async (ctx) => {
  const s = ctx.session = ctx.session || {};
  const nombrePena = s.esperandoPena;
  const tipo = s.esperandoArchivo;

  try {
    const doc = ctx.message.document;
    if (!doc.file_name.endsWith('.txt')) return ctx.reply('Solo archivos .txt', MENU);

    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const resp = await fetch(fileLink.href);
    const text = await resp.text();

    if (nombrePena) {
      const lineas = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
      const res = cargarJugadasPena(nombrePena, lineas);
      s.esperandoPena = null;
      return ctx.reply(res.ok ? `✅ ${res.total} jugadas cargadas en "${nombrePena}".` : `❌ ${res.error}`, MENU);
    }

    if (tipo) {
      const jugadas = parsearMultiplesJugadas(text, tipo);
      if (jugadas.length === 0) return ctx.reply(`No pude parsear jugadas de ${tipo}.`, MENU);

      const destPath = join(__dirname, '..', 'datos', `jugadas_${tipo}.txt`);
      writeFileSync(destPath, text, 'utf-8');
      const lineas = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
      if (tipo === 'quiniela') config.quinielaJugadas = lineas;
      else config.quinigolJugadas = lineas;
      s.esperandoArchivo = null;
      return ctx.reply(`✅ Cargadas ${jugadas.length} jugadas de ${tipo}.`, MENU);
    }

    ctx.reply('Usa "➕ Crear Peña" o /cargar_pena <nombre> primero.', MENU);
  } catch (err) {
    ctx.reply(`Error: ${err.message}`, MENU);
  }
});

// ===== INICIO =====

async function startPolling() {
  console.log('🔍 Iniciando monitorización de partidos...');
  await checkScores();
  setInterval(checkScores, config.POLL_INTERVAL * 1000);
}

// Health check + webhook server
const PORT = process.env.PORT || 8080;
const RENDER_URL = 'https://livescore-bot-qpoh.onrender.com';

// Si estamos en Render, usar webhook en vez de polling
const usarWebhook = !!process.env.RENDER_SERVICE_ID;

createServer(async (req, res) => {
  // Webhook handler para Telegram
  if (usarWebhook && req.url === '/' && req.method === 'POST') {
    try {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      const body = Buffer.concat(buffers).toString();
      await bot.handleUpdate(JSON.parse(body));
    } catch (e) {
      console.error('Error en webhook:', e.message);
    }
    return res.end('OK');
  }

  // Health check
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor en puerto ${PORT} (webhook: ${usarWebhook})`);
});

async function iniciar() {
  if (usarWebhook) {
    await bot.telegram.setWebhook(RENDER_URL);
    console.log('Webhook configurado en', RENDER_URL);
    // Re-set webhook cada 15s para vencer al bot viejo en JustRunMy
    setInterval(() => {
      bot.telegram.setWebhook(RENDER_URL).catch(() => {});
    }, 15000);
  } else {
    await bot.launch();
    console.log('🤖 Bot iniciado (polling)');
  }
  startPolling();
}

iniciar().catch(err => {
  console.error('Error al iniciar:', err.message);
  startPolling();
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
