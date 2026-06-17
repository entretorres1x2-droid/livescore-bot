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
import { formatearBoleto, formatearMejoresColumnas, formatearNotificacionDetallada } from './boleto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
bot.use(session());

const MENU = Markup.keyboard([
  ['📋 Peñas', '📊 Ranking'],
  ['⚽ Partidos', '📅 Jornada'],
  ['📊 Resumen', '➕ Crear Peña'],
  ['❌ Detener Notificaciones'],
]).resize();

function volverBtn(texto = '🏠 Menú Principal') {
  return Markup.inlineKeyboard([[Markup.button.callback(texto, 'menu_principal')]]);
}

let partidosAnteriores = [];
let adminId = null;
let targetGroupId = null;
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
    if (!existsSync(join(__dirname, '..', 'datos'))) {
      mkdirSync(join(__dirname, '..', 'datos'), { recursive: true });
    }
    writeFileSync(DATA_FILE, JSON.stringify({ adminId, targetGroupId }));
  } catch {}
}

loadData();

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

    async function enviarAlGrupo(msg, extra) {
      if (targetGroupId) {
        try { await bot.telegram.sendMessage(targetGroupId, msg, extra || {}); } catch {}
      }
    }

    async function notificarDetalle(result, premios, titulo) {
      if (!targetGroupId) return;
      if (titulo) await enviarAlGrupo(titulo);
      const peñas = listarPenas();
      for (const p of peñas) {
        const partidos = p.tipo === 'quiniela' ? result.quiniela : result.quinigol;
        const msg = formatearNotificacionDetallada(p.nombre, partidos, premios);
        if (msg) await enviarAlGrupo(msg);
      }
    }

    // Anunciar eventos
    for (const p of eventos.inicio) await enviarAlGrupo(`🟢 COMENZÓ: ${p.local} vs ${p.visitante}`);
    for (const p of eventos.final) await enviarAlGrupo(`🏁 FINAL: ${p.local} ${p.golesLocal}-${p.golesVisitante} ${p.visitante}`);
    for (const gol of goles) {
      const infoGol = { ...gol };
      const impactoGlobal = analizarImpacto(infoGol, result.quiniela, result.quinigol,
        config.quinielaJugadas.map(j => parseQuinielaJugada(j)).filter(Boolean),
        config.quinigolJugadas.map(j => parseQuinigolJugada(j)).filter(Boolean));
      await enviarAlGrupo(await generarComentarioIA(infoGol, impactoGlobal), { parse_mode: 'HTML' });
    }

    if (eventos.inicio.length > 0 || eventos.final.length > 0 || goles.length > 0) {
      await notificarDetalle(result, premios, '📊 ACTUALIZACIÓN');
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
    [Markup.button.callback('🔵 Quiniela', 'wizard_tipo_quiniela')],
    [Markup.button.callback('🟢 Quinigol', 'wizard_tipo_quinigol')],
    [Markup.button.callback('❌ Cancelar', 'menu_principal')],
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
  ctx.editMessageText('Cancelado.', Markup.inlineKeyboard([
    [Markup.button.callback('🏠 Menú Principal', 'menu_principal')],
  ]));
});

// === NAVEGACIÓN POR BOTONES INLINE ===

bot.action('menu_principal', async (ctx) => {
  ctx.editMessageText('🏠 Menú Principal. Usa los botones de abajo 👇');
});

bot.action('menu_penas', async (ctx) => {
  const lista = listarPenas();
  if (lista.length === 0) {
    return ctx.editMessageText('No hay peñas todavía.', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Crear Peña', 'menu_crear')],
      [Markup.button.callback('🏠 Menú Principal', 'menu_principal')],
    ]));
  }
  const btns = lista.map(p => [Markup.button.callback(
    `${p.nombre} (${p.tipo})`, `pena_det_${encodeURIComponent(p.nombre)}`
  )]);
  btns.push([Markup.button.callback('🏠 Menú Principal', 'menu_principal')]);
  ctx.editMessageText('📋 PEÑAS DISPONIBLES', Markup.inlineKeyboard(btns));
});

bot.action(/^pena_det_(.+)$/, async (ctx) => {
  const nombre = decodeURIComponent(ctx.match[1]);
  const result = await obtenerPartidosEnVivo();
  const pena = obtenerPena(nombre);
  if (!pena) return ctx.editMessageText('Peña no encontrada.', menuPrincipal());
  const e = escrutarPena(nombre, pena.tipo === 'quiniela' ? result.quiniela : result.quinigol);
  let msg = '';
  if (e) msg = `📊 ${e.nombre} (${e.tipo})\nTotal: ${e.total} | Vivas: ${e.vivas} | Muertas: ${e.muertas}`;
  const cols = formatearMejoresColumnas(nombre, pena.tipo === 'quiniela' ? result.quiniela : result.quinigol);
  if (cols.ok) msg += '\n\n' + cols.msg;
  ctx.editMessageText(msg, Markup.inlineKeyboard([
    [Markup.button.callback('📄 Ver Boleto #1', `boleto_${encodeURIComponent(nombre)}_1`)],
    [Markup.button.callback('📁 Cargar Jugadas', `cargar_${encodeURIComponent(nombre)}`),
     Markup.button.callback('🗑️ Borrar', `borrar_${encodeURIComponent(nombre)}`)],
    [Markup.button.callback('🔙 Volver a Peñas', 'menu_penas'),
     Markup.button.callback('🏠 Menú Principal', 'menu_principal')],
  ]));
});

bot.action(/^boleto_(.+)_(\d+)$/, async (ctx) => {
  const nombre = decodeURIComponent(ctx.match[1]);
  const num = parseInt(ctx.match[2]);
  const result = await obtenerPartidosEnVivo();
  const partidos = obtenerPena(nombre)?.tipo === 'quiniela' ? result.quiniela : result.quinigol;
  if (!partidos) return ctx.editMessageText('Peña no encontrada.', menuPrincipal());
  const b = formatearBoleto(nombre, num, partidos);
  const sigNum = num + 1;
  ctx.editMessageText(b.msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➡️ Siguiente', `boleto_${encodeURIComponent(nombre)}_${sigNum}`)],
      [Markup.button.callback(`🔙 Volver a ${nombre}`, `pena_det_${encodeURIComponent(nombre)}`),
       Markup.button.callback('🏠 Menú Principal', 'menu_principal')],
    ])
  });
});

bot.action(/^cargar_(.+)$/, async (ctx) => {
  const nombre = decodeURIComponent(ctx.match[1]);
  ctx.session.esperandoPena = nombre;
  ctx.editMessageText(`Envía el archivo .txt para "${nombre}".`, Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Cancelar', `pena_det_${encodeURIComponent(nombre)}`)],
  ]));
});

bot.action(/^borrar_(?!ok_)(.+)$/, async (ctx) => {
  const nombre = decodeURIComponent(ctx.match[1]);
  const pena = obtenerPena(nombre);
  if (!pena) return ctx.editMessageText('Peña no encontrada.', menuPrincipal());
  ctx.editMessageText(`¿Seguro que quieres borrar "${nombre}" (${pena.tipo})?`, Markup.inlineKeyboard([
    [Markup.button.callback('✅ Sí, borrar', `borrar_ok_${encodeURIComponent(nombre)}`),
     Markup.button.callback('❌ No', `pena_det_${encodeURIComponent(nombre)}`)],
  ]));
});

bot.action(/^borrar_ok_(.+)$/, async (ctx) => {
  const nombre = decodeURIComponent(ctx.match[1]);
  const res = eliminarPena(nombre);
  ctx.editMessageText(res.ok ? `✅ Peña "${nombre}" borrada.` : `❌ ${res.error}`, Markup.inlineKeyboard([
    [Markup.button.callback('📋 Ver Peñas', 'menu_penas')],
    [Markup.button.callback('🏠 Menú Principal', 'menu_principal')],
  ]));
});

bot.action('menu_ranking', async (ctx) => {
  try {
    const [result, premios] = await Promise.all([obtenerPartidosEnVivo(), obtenerDatosPremios()]);
    const rkQ = formatearRanking('quiniela', result?.quiniela || [], premios);
    const rkG = formatearRanking('quinigol', result?.quinigol || [], premios);
    let msg = '';
    if (rkQ.includes('No hay')) msg += '❌ No hay peñas de quiniela.\n';
    else msg += rkQ + '\n';
    if (rkG.includes('No hay')) msg += '\n❌ No hay peñas de quinigol.';
    else msg += '\n' + rkG;
    ctx.editMessageText(msg, volverBtn());
  } catch (e) {
    ctx.editMessageText(`Error al obtener ranking: ${e.message}`, volverBtn());
  }
});

bot.action('menu_partidos', async (ctx) => {
  const msg = await generarPartidos();
  ctx.editMessageText(msg, volverBtn());
});

bot.action('menu_jornada', async (ctx) => {
  const msg = await generarJornada();
  ctx.editMessageText(msg, volverBtn());
});

bot.action('menu_resumen', async (ctx) => {
  const msg = await generarResumen();
  ctx.editMessageText(msg, volverBtn());
});

bot.action('menu_crear', (ctx) => {
  ctx.editMessageText('¿De qué tipo es la peña?', Markup.inlineKeyboard([
    [Markup.button.callback('🔵 Quiniela', 'wizard_tipo_quiniela')],
    [Markup.button.callback('🟢 Quinigol', 'wizard_tipo_quinigol')],
    [Markup.button.callback('❌ Cancelar', 'menu_principal')],
  ]));
});

bot.action('menu_stop', (ctx) => {
  ctx.editMessageText('Para dejar de recibir notis en el grupo, elimíname del grupo. Las notis van al grupo, no aquí.', Markup.inlineKeyboard([
    [Markup.button.callback('🏠 Menú', 'menu_principal')],
  ]));
});

// ===== COMANDOS =====

// Al añadir el bot a un grupo, lo guarda como destino de notis
bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  if (!update) return;
  const chat = update.chat;
  if (chat.type === 'group' || chat.type === 'supergroup') {
    if (update.new_chat_member.status === 'member' || update.new_chat_member.status === 'administrator') {
      targetGroupId = chat.id;
      saveData();
      if (adminId) await bot.telegram.sendMessage(adminId, `✅ Grupo "${chat.title}" vinculado. Las notis irán allí.`);
    }
  }
});

bot.start((ctx) => {
  if (ctx.chat.type !== 'private') {
    return ctx.reply('🤖 Este bot se controla por privado @SS_Goles_bot. Las notificaciones llegarán aquí automáticamente.');
  }
  adminId = ctx.chat.id;
  saveData();
  ctx.reply(
    '¡Bienvenido al LiveScore Bot! ⚽\n\n' +
    'Te avisaré de cada gol y cómo afecta a tus peñas.\n' +
    (targetGroupId ? `📨 Notis enviándose al grupo configurado.` : '📌 Para enviar notis a un grupo, añádeme allí.'),
    MENU
  );
});

bot.help((ctx) => ctx.reply(
  '📋 Comandos (o usa los botones en privado):\n' +
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
  ctx.chat.type === 'private' ? Markup.removeKeyboard() : Markup.removeKeyboard()
));

// ===== FUNCIONES REUTILIZABLES =====

async function generarJornada() {
  let msg = `📅 Temporada ${config.TEMPORADA}\n`;
  const peñas = listarPenas();
  msg += `Peñas: ${peñas.length}\n\n`;

  try {
    const [jornadaQL, jornadaQGL] = await Promise.all([
      obtenerJornadaQuiniela(), obtenerJornadaQuinigol(),
    ]);

    if (jornadaQL.length > 0) {
      msg += '⚽ QUINIELA:\n' + jornadaQL.map(p =>
        `${p.local} - ${p.visitante} [${p.marcador}]`
      ).join('\n') + '\n\n';
    }
    if (jornadaQGL.length > 0) {
      msg += '⚽ QUINIGOL:\n' + jornadaQGL.map(p =>
        `${p.local} - ${p.visitante} [${p.marcador}]`
      ).join('\n');
    }
    if (jornadaQL.length === 0 && jornadaQGL.length === 0) msg += 'No hay partidos de quiniela/quinigol en esta jornada.';
  } catch (e) { msg += `\n❌ Error: ${e.message}`; }
  return msg;
}

async function generarListaPenas() {
  const lista = listarPenas();
  if (lista.length === 0) return 'No hay peñas. Usa ➕ Crear Peña en el menú.';
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
  return msg || 'No hay jugadas ni peñas. Usa ➕ Crear Peña en el menú.';
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

// En grupos solo ignoramos mensajes (el bot solo escribe)
bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    return; // No procesar nada
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
    return ctx.reply('Peñas: ' + lista.map(p => p.nombre).join(', ') + '\nUsa /pena <nombre> o los botones en privado.', ctx.chat.type === 'private' ? Markup.inlineKeyboard([[Markup.button.callback('📋 Ver Peñas', 'menu_penas')]]) : kb(ctx));
  }
  const result = await obtenerPartidosEnVivo();
  const pena = obtenerPena(nombre);
  if (!pena) return ctx.reply('Peña no encontrada.', ctx.chat.type === 'private' ? Markup.inlineKeyboard([[Markup.button.callback('🏠 Menú', 'menu_principal')]]) : kb(ctx));

  const e = escrutarPena(nombre, pena.tipo === 'quiniela' ? result.quiniela : result.quinigol);
  let msg = '';
  if (e) {
    msg = `📊 ${e.nombre} (${e.tipo})\nTotal: ${e.total} | Vivas: ${e.vivas} | Muertas: ${e.muertas}\n\n`;
    msg += formatearCategorias(e.categorias, e.tipo === 'quiniela' ? 15 : 6);
  }
  const cols = formatearMejoresColumnas(nombre, pena.tipo === 'quiniela' ? result.quiniela : result.quinigol);
  if (cols.ok) msg += '\n\n' + cols.msg;

  ctx.reply(msg, ctx.chat.type === 'private' ? Markup.inlineKeyboard([
    [Markup.button.callback('📄 Ver Boleto #1', `boleto_${encodeURIComponent(nombre)}_1`)],
    [Markup.button.callback('🏠 Menú', 'menu_principal')],
  ]) : kb(ctx));
});

bot.command('cargar_pena', async (ctx) => {
  const nombre = ctx.message.text.slice('/cargar_pena'.length).trim();
  if (!nombre) return ctx.reply('Uso: /cargar_pena <nombre>', kb(ctx));
  const pena = obtenerPena(nombre);
  if (!pena) return ctx.reply(`No existe "${nombre}".`, kb(ctx));
  ctx.session.esperandoPena = nombre;
  ctx.reply(`Envía el archivo .txt para "${nombre}" (${pena.tipo}).`, ctx.chat.type === 'private' ? Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Cancelar', `pena_det_${encodeURIComponent(nombre)}`)],
  ]) : kb(ctx));
});

bot.command('borrar_pena', async (ctx) => {
  const nombre = ctx.message.text.slice('/borrar_pena'.length).trim();
  if (!nombre) {
    const lista = listarPenas();
    if (lista.length === 0) return ctx.reply('No hay peñas.', kb(ctx));
    return ctx.reply('Peñas: ' + lista.map(p => p.nombre).join(', ') + '\nUsa /borrar_pena <nombre>.', kb(ctx));
  }
  const pena = obtenerPena(nombre);
  if (!pena) return ctx.reply(`No existe "${nombre}".`, kb(ctx));
  ctx.reply(
    `¿Seguro que quieres borrar la peña "${nombre}" (${pena.tipo})?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Sí, borrar', `borrar_ok_${encodeURIComponent(nombre)}`)],
      [Markup.button.callback('❌ No', `pena_det_${encodeURIComponent(nombre)}`)],
    ])
  );
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
  ctx.reply(b.msg, { parse_mode: 'Markdown', ...(ctx.chat.type === 'private' ? Markup.inlineKeyboard([
    [Markup.button.callback('🏠 Menú', 'menu_principal')],
  ]) : kb(ctx)) });
});

bot.command('ranking', async (ctx) => {
  try {
    const [result, premios] = await Promise.all([obtenerPartidosEnVivo(), obtenerDatosPremios()]);
    const rkQ = formatearRanking('quiniela', result.quiniela, premios);
    const rkG = formatearRanking('quinigol', result.quinigol, premios);
    let msg = '';
    if (rkQ.includes('No hay')) msg += '❌ No hay peñas de quiniela.\n';
    else msg += rkQ + '\n';
    if (rkG.includes('No hay')) msg += '\n❌ No hay peñas de quinigol.';
    else msg += '\n' + rkG;
    ctx.reply(msg, ctx.chat.type === 'private' ? Markup.inlineKeyboard([[Markup.button.callback('🏠 Menú', 'menu_principal')]]) : kb(ctx));
  } catch (e) {
    ctx.reply(`Error: ${e.message}`, kb(ctx));
  }
});

bot.command('stop', (ctx) => {
  if (ctx.chat.type !== 'private') return;
  ctx.reply('Las notificaciones van al grupo configurado. Para detenerlas, elimíname del grupo.', Markup.inlineKeyboard([
    [Markup.button.callback('🏠 Menú', 'menu_principal')],
  ]));
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
      `✅ Peña "${nombre}" (${tipo}) creada.`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`📊 Ir a ${nombre}`, `pena_det_${encodeURIComponent(nombre)}`)],
        [Markup.button.callback('🏠 Menú Principal', 'menu_principal')],
      ])
    );
  }

  // Menú de teclado (fijo en la parte inferior)
  if (isPrivate) {
    if (txt === '📋 Peñas') {
      const lista = listarPenas();
      if (lista.length === 0) return ctx.reply('No hay peñas todavía. Usa "➕ Crear Peña".', MENU);
      const msg = lista.map(p => `${p.nombre} (${p.tipo})`).join('\n');
      return ctx.reply(`📋 PEÑAS:\n\n${msg}`, Markup.inlineKeyboard([
        ...lista.map(p => [Markup.button.callback(p.nombre, `pena_det_${encodeURIComponent(p.nombre)}`)]),
        [Markup.button.callback('➕ Crear Peña', 'menu_crear')],
      ]));
    }
    if (txt === '📊 Ranking') {
      try {
        const [result, premios] = await Promise.all([obtenerPartidosEnVivo(), obtenerDatosPremios()]);
        const rkQ = formatearRanking('quiniela', result?.quiniela || [], premios);
        const rkG = formatearRanking('quinigol', result?.quinigol || [], premios);
        let msg = '';
        if (rkQ.includes('No hay')) msg += '❌ No hay peñas de quiniela.\n';
        else msg += rkQ + '\n';
        if (rkG.includes('No hay')) msg += '\n❌ No hay peñas de quinigol.';
        else msg += '\n' + rkG;
        ctx.reply(msg, MENU);
      } catch (e) { ctx.reply(`Error: ${e.message}`, MENU); }
      return;
    }
    if (txt === '⚽ Partidos') return ctx.reply(await generarPartidos(), MENU);
    if (txt === '📅 Jornada') return ctx.reply(await generarJornada(), MENU);
    if (txt === '📊 Resumen') return ctx.reply(await generarResumen(), MENU);
    if (txt === '➕ Crear Peña') return iniciarWizard(ctx);
    if (txt === '❌ Detener Notificaciones') {
      return ctx.reply('Las notificaciones van al grupo configurado. Para detenerlas, elimíname del grupo.', MENU);
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
      const ok = res.ok;
      ctx.reply(ok ? `✅ ${res.total} jugadas cargadas en "${nombrePena}".` : `❌ ${res.error}`, Markup.inlineKeyboard([
        [Markup.button.callback(`📊 Ir a ${nombrePena}`, `pena_det_${encodeURIComponent(nombrePena)}`)],
        [Markup.button.callback('🏠 Menú Principal', 'menu_principal')],
      ]));
      return;
    }

    ctx.reply('Usa "➕ Crear Peña" o /cargar_pena <nombre> primero.', Markup.inlineKeyboard([
      [Markup.button.callback('🏠 Menú Principal', 'menu_principal')],
    ]));
  } catch (err) {
    ctx.reply(`Error: ${err.message}`, Markup.inlineKeyboard([
      [Markup.button.callback('🏠 Menú Principal', 'menu_principal')],
    ]));
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

createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor en puerto ${PORT}`);
});

async function startBotPolling() {
  let offset = 0;
  console.log('🤖 Iniciando polling manual...');
  const poll = async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, timeout: 30, allowed_updates: ['message', 'callback_query', 'my_chat_member'] })
      });
      const data = await res.json();
      if (data.ok && data.result) {
        for (const u of data.result) {
          if (u.update_id >= offset) offset = u.update_id + 1;
          try { await bot.handleUpdate(u); } catch (e) { console.error('Error update:', e.message); }
        }
      }
    } catch (e) { console.error('Error polling:', e.message); }
    setTimeout(poll, 1000);
  };
  poll();
}

async function iniciar() {
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  startBotPolling();
  console.log('🤖 Bot iniciado (polling manual)');
  setInterval(() => fetch(`http://localhost:${PORT}`).catch(() => {}), 180000);
  startPolling();
}

iniciar().catch(err => {
  console.error('Error al iniciar:', err.message);
  startPolling();
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
