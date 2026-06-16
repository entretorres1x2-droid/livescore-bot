import { parseQuinielaJugada, parseQuinigolJugada } from './parser.js';
import { analizarQuiniela, analizarQuinigol } from './analyzer.js';
import { obtenerPena } from './penas.js';

function acortar(nombre, max = 8) {
  if (!nombre) return '???';
  return nombre.length > max ? nombre.slice(0, max - 1) + '…' : nombre.padEnd(max);
}

function finalizados(partidos) {
  return partidos.filter(p => p.finalizado || p.estado === 'post').length;
}

function formatearPronostico(jugada, idx, tipo) {
  if (tipo === 'quiniela') {
    if (idx === 14) {
      if (!jugada.pleno) return ' - ';
      return `${jugada.pleno.local}${jugada.pleno.visitante}`.padStart(4);
    }
    const cols = jugada.columnas[idx];
    if (!cols) return ' - ';
    return cols.join('/').padStart(4);
  }
  const par = jugada.partidos[idx];
  if (!par) return ' - ';
  return `${par.local}${par.visitante}`.padStart(4);
}

function estimar(tipo, categoria) {
  const pcts = tipo === 'quiniela'
    ? [15, 14, 13, 12, 11, 10]
    : [6, 5, 4, 3, 2];
  const pctVal = tipo === 'quiniela'
    ? [10, 10.5, 11.5, 11.5, 11.5, 0]
    : [12, 12, 12, 12, 2];
  const idx = pcts.indexOf(categoria);
  if (idx < 0) return 0;
  return Math.round(1_200_000 * (pctVal[idx] / 100));
}

export function formatearBoleto(penaNombre, numJugada, partidos) {
  const pena = obtenerPena(penaNombre);
  if (!pena) return { ok: false, msg: 'Peña no encontrada.' };

  const raw = pena.jugadas[numJugada - 1];
  if (!raw) return { ok: false, msg: `No existe la jugada #${numJugada}.` };

  const tipo = pena.tipo;
  const parseFn = tipo === 'quiniela' ? parseQuinielaJugada : parseQuinigolJugada;
  const analizar = tipo === 'quiniela' ? analizarQuiniela : analizarQuinigol;
  const jugada = parseFn(raw);
  if (!jugada) return { ok: false, msg: 'Error al parsear la jugada.' };

  const total = tipo === 'quiniela' ? 15 : 6;
  const resultadosArr = partidos.map(p => ({
    local: p.golesLocal, visitante: p.golesVisitante,
  }));

  let lineas = [];
  let aciertosTotal = 0;
  let viva = true;

  const titulo = tipo === 'quiniela' ? '🎫 BOLETO QUINIELA' : '🎫 BOLETO QUINIGOL';
  lineas.push('```');
  lineas.push(`┌─────────────────────────────────────────┐`);
  lineas.push(`│  ${titulo}  #${numJugada}${''.padEnd(15)}│`);
  lineas.push(`├──┬──────────────────┬─────┬─────┬───────┤`);
  lineas.push(`│ #│ Partido          │ Pron│ Res │ Estado│`);
  lineas.push(`├──┼──────────────────┼─────┼─────┼───────┤`);

  for (let i = 0; i < total; i++) {
    const p = partidos[i] || {};
    const res = analizar(resultadosArr, jugada, i);
    const pron = formatearPronostico(jugada, i, tipo);
    const score = p.golesLocal !== null ? `${p.golesLocal}-${p.golesVisitante}` : ' - ';
    const estado = p.finalizado || p.estado === 'post' ? (res.viva ? '✅' : '💀') : '⏳';
    const num = String(i + 1).padStart(2);
    const local = acortar(p.local, 7);
    const visit = acortar(p.visitante, 7);

    lineas.push(`│${num}│${local} - ${visit}│ ${pron} │ ${score} │  ${estado}  │`);
    if (!res.viva) viva = false;
    if (res.aciertos > 0) aciertosTotal++;
  }

  lineas.push(`├──┴──────────────────┴─────┴─────┴───────┤`);

  const pendientes = partidos.filter(p => !p.finalizado && p.estado !== 'post').length;
  const maxPosible = Math.min(aciertosTotal + pendientes, total);
  const maxCat = viva ? maxPosible : '💀';
  const premioEst = typeof maxCat === 'number' && maxCat > 0 ? estimar(tipo, maxCat) : 0;

  lineas.push(`│ Aciertos: ${aciertosTotal}/${finalizados(partidos)}   Viva: ${viva ? '✅' : '💀'} │`);
  lineas.push(`│ Máx categoría: ${maxCat}${viva ? '✓' : ''}${''.padEnd(18)}│`);
  if (premioEst > 0) lineas.push(`│ Premio est: ~${premioEst.toLocaleString('es-ES')}€${''.padEnd(16)}│`);
  lineas.push(`└─────────────────────────────────────────┘`);
  lineas.push('```');

  return { ok: true, msg: lineas.join('\n') };
}

export function formatearMejoresColumnas(penaNombre, partidos) {
  const pena = obtenerPena(penaNombre);
  if (!pena) return { ok: false, msg: 'Peña no encontrada.' };

  const tipo = pena.tipo;
  const parseFn = tipo === 'quiniela' ? parseQuinielaJugada : parseQuinigolJugada;
  const analizar = tipo === 'quiniela' ? analizarQuiniela : analizarQuinigol;
  const total = tipo === 'quiniela' ? 15 : 6;

  const columnas = [];
  for (let idx = 0; idx < pena.jugadas.length; idx++) {
    const raw = pena.jugadas[idx];
    const jugada = parseFn(raw);
    if (!jugada) continue;

    const resultadosArr = partidos.map(p => ({
      local: p.golesLocal, visitante: p.golesVisitante,
    }));

    let aciertos = 0;
    let viva = true;
    for (let i = 0; i < total; i++) {
      const res = analizar(resultadosArr, jugada, i);
      if (!res.viva) { viva = false; break; }
      if (res.aciertos > 0) aciertos++;
    }

    const pendientes = partidos.filter(p => !p.finalizado && p.estado !== 'post').length;
    const maxPosible = Math.min(aciertos + (viva ? pendientes : 0), total);

    columnas.push({ num: idx + 1, raw, aciertos, viva, maxPosible });
  }

  if (columnas.length === 0) return { ok: false, msg: 'No hay jugadas en esta peña.' };

  // Ordenar: vivas primero, luego por maxPosible descendente
  columnas.sort((a, b) => {
    if (a.viva !== b.viva) return a.viva ? -1 : 1;
    return b.maxPosible - a.maxPosible;
  });

  const lineas = [];
  lineas.push(`📊 MEJORES COLUMNAS - ${pena.nombre.toUpperCase()}`);
  lineas.push(`Total: ${columnas.length} | Vivas: ${columnas.filter(c => c.viva).length}`);
  lineas.push('```');
  lineas.push(` #  │ Columna           │ Act │ Max │`);
  lineas.push(`────┼───────────────────┼─────┼─────┤`);

  const maxMostrar = 20;
  for (const c of columnas.slice(0, maxMostrar)) {
    const num = String(c.num).padStart(2);
    const raw = c.raw.length > 16 ? c.raw.slice(0, 16) + '…' : c.raw.padEnd(16);
    const act = `${c.aciertos}`.padStart(3);
    const max = c.viva ? `${c.maxPosible}✓`.padStart(3) : ' 💀';
    lineas.push(` ${num} │ ${raw} │ ${act} │ ${max} │`);
  }

  if (columnas.length > maxMostrar) {
    lineas.push(`────┼───────────────────┼─────┼─────┤`);
    lineas.push(`    │ ... y ${columnas.length - maxMostrar} más`);
  }

  lineas.push('```');
  return { ok: true, msg: lineas.join('\n') };
}
