/**
 * Live Scores gratuito vía ESPN API (sin key) + Losilla API + fallback local
 *
 * ESPN: https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard
 *   - Sin API key, gratis, datos en tiempo real
 *
 * Losilla: https://api.eduardolosilla.es/
 *   - Actualmente requiere autenticación (401), se usa fallback local
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';

const __dirname2 = dirname(fileURLToPath(import.meta.url));

function cargarFallback(tipo) {
  try {
    const path = join(__dirname2, '..', 'datos', 'jornadas_fallback.json');
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const key = `${config.TEMPORADA}_${tipo === 'quiniela' ? config.JORNADA_QUINIELA : config.JORNADA_QUINIGOL}_${tipo}`;
    return data[key] || null;
  } catch { return null; }
}

let cacheTodos = [];

function dateStr(d, offsetDias = 0) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + offsetDias);
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fixName(txt) {
  const list = ['real', 'fc', 'sd', 'ud', 'cd', 'cf', 'rc', 'sad', 'de', 'club', 'at', 'ath', 'vigo', 'r', 'b'];
  const words = txt.split(' ');
  if (words.length <= 1) return txt;
  const filtered = words.filter(w => !list.includes(w)).join(' ');
  return filtered.length > 0 ? filtered : txt;
}

const teamMappings = {
  'ath club': 'athletic',
  'at madrid': 'atletico',
  'r madrid': 'madrid',
  'psg': 'paris',
  'porto': 'porto',
  'oporto': 'porto',
  'friburgo': 'freiburg',
  'freiburg': 'freiburg',
  'celta': 'celta',
  'leverkusen': 'leverkusen',
  'stuttgart': 'stuttgart',
  'lyon': 'lyon',
  'genk': 'genk',
};

function prepararEquipo(name) {
  const n = normalize(name);
  for (const [k, v] of Object.entries(teamMappings)) {
    if (n.includes(k)) return v;
  }
  return fixName(n);
}

function matchEquipos(nombreLosilla, nombreESPN) {
  const target = prepararEquipo(nombreLosilla);
  const full = normalize(nombreESPN);
  const short = normalize(nombreESPN.replace(/[^a-z0-9]/g, ''));
  return full.includes(target) || short.includes(target) || (target.length >= 4 && full.includes(target.slice(0, 4)));
}

async function fetchJSON(url) {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'LiveScoreBot/1.0' } });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

// --- DETECCIÓN DE JORNADA ACTUAL ---

async function fetchJornada(tipo, j) {
  const url = tipo === 'quiniela'
    ? `https://api.eduardolosilla.es/escrutinios?num_jornada=${j}&num_temporada=${config.TEMPORADA}`
    : `https://api.eduardolosilla.es/quinigol/escrutinios?temporada=${config.TEMPORADA}&jornada=${j}`;
  const data = await fetchJSON(url);
  return data?.partidos || [];
}

async function fetchJornadaData(tipo, j) {
  const url = tipo === 'quiniela'
    ? `https://api.eduardolosilla.es/escrutinios?num_jornada=${j}&num_temporada=${config.TEMPORADA}`
    : `https://api.eduardolosilla.es/quinigol/escrutinios?temporada=${config.TEMPORADA}&jornada=${j}`;
  return await fetchJSON(url);
}

function tieneEquiposValidos(partidos) {
  return partidos.some(p => {
    const loc = typeof p.local === 'object' ? p.local.nombre : p.local;
    return loc && !loc.includes('DETERMINAR');
  });
}

function todosFinalizados(partidos) {
  return partidos.length > 0 && partidos.every(p => {
    const res = p.resultado || p.marcador || '';
    return p.estado === 'Finalizado' || p.estado === 'Escrutado' || (res !== '' && res !== '-:-' && res !== '-');
  });
}

async function detectarJornadaActual(tipo) {
  let jInicial = tipo === 'quiniela' ? parseInt(config.JORNADA_QUINIELA) : parseInt(config.JORNADA_QUINIGOL);
  let fallback = jInicial;
  let hayActiva = false;
  const maxLook = 50;

  function estaActiva(data) {
    if (!data?.partidos?.length) return null;
    if (!tieneEquiposValidos(data.partidos)) return null;
    if (data.estado === 'ABIERTA') return true;
    if (data.escrutinio?.estadoJornada === 'Abierta') return true;
    // Cerrada = apuestas cerradas, partidos aún por jugar
    if (data.escrutinio?.estadoJornada === 'Cerrada' && !todosFinalizados(data.partidos)) return true;
    // Si hay campo estado pero no es activo -> no activa
    if (data.estado || data.escrutinio?.estadoJornada) return false;
    // Fallback solo si no hay estado en la respuesta
    return !todosFinalizados(data.partidos);
  }

  // Buscar hacia delante primero (más probable)
  for (let j = jInicial; j <= jInicial + maxLook; j++) {
    const data = await fetchJornadaData(tipo, j);
    const activa = estaActiva(data);
    if (activa === null) continue;
    fallback = j;
    if (activa) return { jornada: j, activa: true };
  }

  // Buscar hacia atrás
  for (let j = jInicial - 1; j >= Math.max(1, jInicial - 20); j--) {
    const data = await fetchJornadaData(tipo, j);
    const activa = estaActiva(data);
    if (activa === null) continue;
    fallback = j;
    if (activa) return { jornada: j, activa: true };
  }

  return { jornada: fallback, activa: hayActiva };
}



export async function verificarAvanceJornada() {
  const dataQ = await fetchJornadaData('quiniela', parseInt(config.JORNADA_QUINIELA));
  const dataQG = await fetchJornadaData('quinigol', parseInt(config.JORNADA_QUINIGOL));

  const qCerrada = dataQ?.estado === 'ESCRUTADA' || dataQ?.estado === 'CERRADA' ||
    (dataQ?.partidos?.length > 0 && todosFinalizados(dataQ.partidos));
  const qgCerrada = dataQG?.escrutinio?.estadoJornada === 'Escrutada' ||
    dataQG?.escrutinio?.estadoJornada === 'Cerrada' ||
    (dataQG?.partidos?.length > 0 && todosFinalizados(dataQG.partidos));

  if (qCerrada) {
    const nuevaJ = parseInt(config.JORNADA_QUINIELA) + 1;
    const prox = await fetchJornadaData('quiniela', nuevaJ);
    if (prox?.partidos?.length && tieneEquiposValidos(prox.partidos)) {
      config.JORNADA_QUINIELA = String(nuevaJ);
      console.log('Jornada Quiniela avanzada a J' + nuevaJ);
    }
  }

  if (qgCerrada) {
    const nuevaJ = parseInt(config.JORNADA_QUINIGOL) + 1;
    const prox = await fetchJornadaData('quinigol', nuevaJ);
    if (prox?.partidos?.length && tieneEquiposValidos(prox.partidos)) {
      config.JORNADA_QUINIGOL = String(nuevaJ);
      console.log('Jornada Quinigol avanzada a J' + nuevaJ);
    }
  }

  return { qFinalizada: qCerrada, qgFinalizada: qgCerrada };
}

// --- LOSILLA API ---

function mapearPartido(p, i, tipo) {
  const local = typeof p.local === 'object' ? p.local.nombre : p.local;
  const visitante = typeof p.visitante === 'object' ? p.visitante.nombre : p.visitante;
  const resultado = p.resultado || p.marcador || '-:-';
  const estado = p.estado || '';

  let marcador, signo;
  if (resultado !== '-:-' && resultado !== '') {
    marcador = resultado;
    if (tipo === 'quiniela') {
      signo = p.signo || p.ganador || '-';
    } else {
      signo = p.signo || p.ganador || (resultado === '-:-' ? '-' : resultado);
    }
  } else {
    marcador = '-:-';
    signo = p.signo || p.ganador || '-';
  }

  const base = {
    idx: i,
    local, visitante,
    estado,
    marcador,
    signo,
    finalizado: estado.includes('Finalizado') || estado.includes('Escrutado') || (resultado !== '-:-' && resultado !== '' && resultado !== '-'),
  };

  if (tipo === 'quiniela') {
    return { ...base, dia: p.dia, hora: p.hora };
  }
  return { ...base, dia: p.horario?.dia, hora: p.horario?.hora };
}

async function obtenerJornadaDesdeAPI(tipo, jReal) {
  const url = tipo === 'quiniela'
    ? `https://api.eduardolosilla.es/escrutinios?num_jornada=${jReal}&num_temporada=${config.TEMPORADA}`
    : `https://api.eduardolosilla.es/quinigol/escrutinios?temporada=${config.TEMPORADA}&jornada=${jReal}`;
  const data = await fetchJSON(url);
  if (data?.partidos) return data.partidos.map((p, i) => mapearPartido(p, i, tipo));
  return null;
}

export async function obtenerJornadaQuiniela() {
  const info = await detectarJornadaActual('quiniela');
  const jReal = info.jornada;
  if (String(jReal) !== config.JORNADA_QUINIELA) {
    config.JORNADA_QUINIELA = String(jReal);
    console.log('Jornada Quiniela auto-detectada: J' + jReal + (info.activa ? '' : ' (temporada finalizada)'));
  }
  const api = await obtenerJornadaDesdeAPI('quiniela', jReal);
  if (api) return api;
  const fallback = cargarFallback('quiniela');
  if (fallback) return fallback.map((p, i) => ({
    local: typeof p.local === 'object' ? p.local.nombre : p.local,
    visitante: typeof p.visitante === 'object' ? p.visitante.nombre : p.visitante,
    marcador: p.marcador || '-:-',
    idx: p.idx || i,
    finalizado: p.finalizado || false,
    estado: p.estado,
    dia: p.dia,
    hora: p.hora,
  }));
  return [];
}

export async function obtenerJornadaQuinigol() {
  const info = await detectarJornadaActual('quinigol');
  const jReal = info.jornada;
  if (String(jReal) !== config.JORNADA_QUINIGOL) {
    config.JORNADA_QUINIGOL = String(jReal);
    console.log('Jornada Quinigol auto-detectada: J' + jReal + (info.activa ? '' : ' (temporada finalizada)'));
  }
  const api = await obtenerJornadaDesdeAPI('quinigol', jReal);
  if (api) return api;
  const fallback = cargarFallback('quinigol');
  if (fallback) return fallback.map((p, i) => ({
    local: typeof p.local === 'object' ? p.local.nombre : p.local,
    visitante: typeof p.visitante === 'object' ? p.visitante.nombre : p.visitante,
    marcador: p.marcador || '-:-',
    idx: p.idx || i,
    finalizado: p.finalizado || false,
    estado: p.estado,
    dia: p.dia,
    hora: p.hora,
  }));
  return [];
}

// --- ESPN API (ligas españolas + general) ---

const LIGAS_ESPANOLAS = ['esp.1', 'esp.2', 'esp.3', 'esp.4'];

export async function obtenerEventosESPN() {
  const ahora = new Date();
  const dateIni = dateStr(ahora, -4);
  const dateFin = dateStr(ahora, 2);

  const promesasLigas = LIGAS_ESPANOLAS.map(liga =>
    fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/${liga}/scoreboard?dates=${dateIni}-${dateFin}&limit=100`)
  );

  promesasLigas.push(
    fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${dateIni}-${dateFin}&limit=1000`)
  );

  const resultados = await Promise.all(promesasLigas);
  const eventosMap = new Map();

  for (const res of resultados) {
    if (res?.events) {
      for (const ev of res.events) {
        if (!eventosMap.has(ev.id)) {
          eventosMap.set(ev.id, ev);
        }
      }
    }
  }

  return [...eventosMap.values()];
}

function extraerDatosPartido(event) {
  const comp = event.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find(c => c.homeAway === 'home');
  const away = comp.competitors?.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  return {
    id: event.id,
    local: home.team.displayName,
    visitante: away.team.displayName,
    golesLocal: parseInt(home.score) || 0,
    golesVisitante: parseInt(away.score) || 0,
    minuto: event.status?.displayClock || "0'",
    estado: event.status?.type?.state || 'pre',
    detalle: event.status?.type?.shortDetail || '',
    fecha: event.date,
  };
}

// --- EMPAREJAMIENTO (solo eventos españoles) ---

function buscarMatch(local, visitante, eventos, diaSemana) {
  if (!diaSemana) return null;
  // Si diaSemana contiene "/" es fecha (DD/MM), ignorar filtro de día
  const esFecha = diaSemana.includes('/');
  let targetDia = null;
  if (!esFecha) targetDia = normalize(diaSemana).toUpperCase().slice(0, 3);

  for (const ev of eventos) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;

    if (!esFecha) {
      const dayEng = new Date(ev.date).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Europe/Madrid' });
      const mapDia = { Sun: 'DOM', Mon: 'LUN', Tue: 'MAR', Wed: 'MIE', Thu: 'JUE', Fri: 'VIE', Sat: 'SAB' };
      const evDia = mapDia[dayEng];
      if (!evDia || evDia !== targetDia) continue;
    }

    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) continue;

    const homeName = normalize(home.team.displayName);
    const awayName = normalize(away.team.displayName);

    if (matchEquipos(local, homeName) && matchEquipos(visitante, awayName)) {
      return extraerDatosPartido(ev);
    }
    if (matchEquipos(local, awayName) && matchEquipos(visitante, homeName)) {
      return extraerDatosPartido(ev);
    }
  }

  return null;
}

function emparejarJornada(jornada, eventos, prefijoId) {
  const resultado = [];
  for (const p of jornada) {
    const match = buscarMatch(p.local, p.visitante, eventos, p.dia);
    if (match) {
      const noEmpezado = match.estado === 'pre' && match.golesLocal === 0 && match.golesVisitante === 0;
      resultado.push({
        ...match,
        idxJornada: p.idx,
        finalizado: match.finalizado ?? p.finalizado,
        golesLocal: noEmpezado ? null : match.golesLocal,
        golesVisitante: noEmpezado ? null : match.golesVisitante,
      });
    } else if (p.finalizado) {
      const [gL, gV] = (p.marcador || '-:-').split('-').map(Number);
      resultado.push({
        id: `${prefijoId}-${p.idx}`,
        local: p.local,
        visitante: p.visitante,
        golesLocal: isNaN(gL) ? 0 : gL,
        golesVisitante: isNaN(gV) ? 0 : gV,
        minuto: 'FT',
        estado: 'post',
        detalle: 'Finalizado ' + p.marcador,
        idxJornada: p.idx,
        finalizado: true,
      });
    } else {
      resultado.push({
        id: `${prefijoId}-${p.idx}`,
        local: p.local,
        visitante: p.visitante,
        golesLocal: null,
        golesVisitante: null,
        minuto: p.dia + ' ' + (p.hora || ''),
        estado: 'pre',
        detalle: 'Programado',
        idxJornada: p.idx,
        finalizado: false,
      });
    }
  }
  return resultado;
}

// --- DATOS DE PREMIOS (recaudación, bote, acertantes) ---

export async function obtenerDatosPremios() {
  try {
    const infoQ = await detectarJornadaActual('quiniela');
    const infoQG = await detectarJornadaActual('quinigol');

    const [dataQ, dataQG] = await Promise.all([
      fetchJornadaData('quiniela', infoQ.jornada),
      fetchJornadaData('quinigol', infoQG.jornada),
    ]);

    const premiosQ = {
      recaudacion: parseFloat((dataQ?.recaudacion || '0').replace(/\./g, '').replace(',', '.')),
      bote: parseFloat((dataQ?.bote || '0').replace(/\./g, '').replace(',', '.')),
      acertantes: (dataQ?.acertantes || []).map(a => ({
        categoria: a.acierto,
        acertantes: a.acertantes,
        premio: a.premio,
      })),
      estado: dataQ?.estado || '',
    };

    const premiosQG = {
      recaudacion: dataQG?.escrutinio?.recaudacion || 0,
      bote: dataQG?.escrutinio?.bote || 0,
      acertantes: (dataQG?.escrutinio?.categoriasAciertos || []).map(a => ({
        categoria: a.numAciertos,
        acertantes: a.numAcertantes,
        premio: a.premio,
      })),
      estado: dataQG?.escrutinio?.estadoJornada || '',
    };

    return { quiniela: premiosQ, quinigol: premiosQG };
  } catch (err) {
    console.error('Error en obtenerDatosPremios:', err.message);
    return {
      quiniela: { recaudacion: 0, bote: 0, acertantes: [], estado: '' },
      quinigol: { recaudacion: 0, bote: 0, acertantes: [], estado: '' },
    };
  }
}

// --- PARTIDOS EN VIVO ---

export async function obtenerPartidosEnVivo() {
  try {
    const [eventos, jornadaQ, jornadaQG] = await Promise.all([
      obtenerEventosESPN(),
      obtenerJornadaQuiniela(),
      obtenerJornadaQuinigol(),
    ]);

    const quiniela = emparejarJornada(jornadaQ, eventos, 'q');
    const quinigol = emparejarJornada(jornadaQG, eventos, 'qg');
    const todos = [...quiniela, ...quinigol];

    cacheTodos = todos;
    return { todos, quiniela, quinigol };
  } catch (err) {
    console.error('Error en obtenerPartidosEnVivo:', err.message);
    return { todos: [], quiniela: [], quinigol: [] };
  }
}

export function detectarGolesNuevos(partidosActuales, partidosAnteriores) {
  if (!partidosAnteriores || partidosAnteriores.length === 0) return [];

  const goles = [];
  for (const actual of partidosActuales) {
    if (actual.estado === 'post') continue;
    const prev = partidosAnteriores.find(p => p.id === actual.id);
    if (!prev) continue;

    const difLocal = (actual.golesLocal || 0) - (prev.golesLocal || 0);
    const difVisit = (actual.golesVisitante || 0) - (prev.golesVisitante || 0);

    if (difLocal > 0) {
      goles.push({
        id: actual.id,
        equipo: actual.local,
        rival: actual.visitante,
        minuto: actual.minuto,
        golesLocal: actual.golesLocal,
        golesVisitante: actual.golesVisitante,
        partido: `${actual.local} vs ${actual.visitante}`,
        quien: 'local',
      });
    }
    if (difVisit > 0) {
      goles.push({
        id: actual.id,
        equipo: actual.visitante,
        rival: actual.local,
        minuto: actual.minuto,
        golesLocal: actual.golesLocal,
        golesVisitante: actual.golesVisitante,
        partido: `${actual.local} vs ${actual.visitante}`,
        quien: 'visitante',
      });
    }
  }
  return goles;
}

export function detectarEventosPartido(partidosActuales, partidosAnteriores) {
  if (!partidosAnteriores || partidosAnteriores.length === 0) {
    return { inicio: [], final: [] };
  }

  const inicio = [];
  const final = [];

  for (const actual of partidosActuales) {
    const prev = partidosAnteriores.find(p => p.id === actual.id);
    if (!prev) continue;

    const prevActivo = prev.golesLocal !== null && prev.estado !== 'post';
    const ahoraActivo = actual.golesLocal !== null && actual.estado !== 'post';
    const prevNull = prev.golesLocal === null;

    // Inicio: antes estaba null/pre, ahora tiene marcador activo
    if (prevNull && ahoraActivo) {
      inicio.push(actual);
    }

    // Final: antes estaba activo, ahora post
    if (prevActivo && actual.estado === 'post') {
      final.push(actual);
    }
  }

  return { inicio, final };
}
