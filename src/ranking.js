import { listarPenas, escrutarPena, obtenerPena } from './penas.js';
import { parseQuinielaJugada, parseQuinigolJugada } from './parser.js';
import { analizarQuiniela, analizarQuinigol } from './analyzer.js';

// Porcentajes de recaudación destinados a cada categoría (LAE / Quinielandia)
const PCT_Q = [
  { categoria: 15, pct: 10.0 },  // + bote acumulado
  { categoria: 14, pct: 10.5 },
  { categoria: 13, pct: 11.5 },
  { categoria: 12, pct: 11.5 },
  { categoria: 11, pct: 11.5 },
  { categoria: 10, pct: 0.0 },
];

const PCT_QG = [
  { categoria: 6, pct: 12.0 },
  { categoria: 5, pct: 12.0 },
  { categoria: 4, pct: 12.0 },
  { categoria: 3, pct: 12.0 },
  { categoria: 2, pct: 2.0 },
];

function estimarPremio(recaudacion, bote, categoria, pcts, tipo) {
  if (!recaudacion || recaudacion <= 0) return 0;
  const pc = pcts.find(p => p.categoria === categoria);
  if (!pc) return 0;
  let pool = recaudacion * (pc.pct / 100);
  if (tipo === 'quiniela' && categoria === 15) pool += bote || 0;
  return Math.round(pool);
}

function calcularMaxCategoria(partidos, jugadasRaw, tipo) {
  if (!partidos || !Array.isArray(partidos)) return { max: 0, min: 0, maxCat: 0, numVivas: 0 };
  const totalPartidos = partidos.length;
  if (totalPartidos === 0 || jugadasRaw.length === 0) return { max: 0, min: 0, maxCat: 0, numVivas: 0 };

  const parseFn = tipo === 'quiniela' ? parseQuinielaJugada : parseQuinigolJugada;
  const analizar = tipo === 'quiniela' ? analizarQuiniela : analizarQuinigol;
  const maxAciertos = tipo === 'quiniela' ? 15 : 6;

  const resultados = jugadasRaw.map(raw => {
    const jugada = parseFn(raw);
    if (!jugada) return null;

    let aciertosConfirmados = 0;
    let muerta = false;

    for (let i = 0; i < totalPartidos; i++) {
      const p = partidos[i];
      const finalizado = p.finalizado || p.estado === 'post';

      if (!finalizado) continue;

      const res = { local: p.golesLocal, visitante: p.golesVisitante };
      const resultadosArr = [];

      for (let j = 0; j < totalPartidos; j++) {
        const pj = partidos[j];
        resultadosArr.push({
          local: (pj.finalizado || pj.estado === 'post') ? pj.golesLocal : null,
          visitante: (pj.finalizado || pj.estado === 'post') ? pj.golesVisitante : null,
        });
      }

      const analisis = analizar(resultadosArr, jugada, i);
      if (!analisis.viva) { muerta = true; break; }
      if (analisis.aciertos > 0) aciertosConfirmados++;
    }

    if (muerta) return null;

    const pendientes = partidos.filter(p => !p.finalizado && p.estado !== 'post').length;
    const maxPosible = Math.min(aciertosConfirmados + pendientes, maxAciertos);
    return { aciertosConfirmados, maxPosible, muerta: false };
  }).filter(Boolean);

  if (resultados.length === 0) return { max: 0, min: 0, maxCat: 0, numVivas: 0 };

  const minAciertos = Math.min(...resultados.map(r => r.aciertosConfirmados));
  const maxAciertosVivos = Math.max(...resultados.map(r => r.maxPosible));
  const maxCat = Math.min(maxAciertosVivos, maxAciertos);

  return { max: maxAciertosVivos, min: minAciertos, maxCat, numVivas: resultados.length };
}

function calcularRanking(tipo, partidos, premios) {
  if (!partidos || !Array.isArray(partidos)) return [];
  const peñas = listarPenas().filter(p => p.tipo === tipo);
  const finalizados = partidos.filter(p => p.finalizado || p.estado === 'post').length;

  const pcts = tipo === 'quiniela' ? PCT_Q : PCT_QG;
  const rec = tipo === 'quiniela' ? premios?.quiniela : premios?.quinigol;
  const recaudacion = rec?.recaudacion || 0;
  const bote = rec?.bote || 0;

  const resultados = peñas.map(p => {
    const e = escrutarPena(p.nombre, partidos);
    if (!e || e.total === 0) return null;

    const aciertosTotales = e.escrutinio.reduce((sum, j) => sum + j.aciertos, 0);
    const maxPosibles = e.total * finalizados;
    const pct = maxPosibles > 0 ? Math.round((aciertosTotales / maxPosibles) * 100) : 0;

    const cat = calcularMaxCategoria(partidos, p.jugadas, tipo);
    const premioEstimado = estimarPremio(recaudacion, bote, cat.maxCat, pcts, tipo);
    const catMin = Math.max(cat.min, tipo === 'quiniela' ? 10 : 2);
    const premioMin = estimarPremio(recaudacion, bote, catMin, pcts, tipo);

    return {
      nombre: p.nombre,
      vivas: e.vivas,
      muertas: e.muertas,
      total: e.total,
      aciertos: aciertosTotales,
      pct,
      finalizados,
      maxCat: cat.maxCat,
      minCat: cat.min,
      premioMax: premioEstimado,
      premioMin,
    };
  }).filter(Boolean);

  resultados.sort((a, b) => b.pct - a.pct || b.vivas - a.vivas || b.maxCat - a.maxCat);
  return resultados;
}

export function formatearRanking(tipo, partidos, premios) {
  const ranking = calcularRanking(tipo, partidos, premios);
  if (ranking.length === 0) return `No hay peñas de ${tipo}.`;

  const pcts = tipo === 'quiniela' ? PCT_Q : PCT_QG;
  const rec = tipo === 'quiniela' ? premios?.quiniela : premios?.quinigol;
  const recStr = rec?.recaudacion ? rec.recaudacion.toLocaleString('es-ES') + '€' : 's/d';

  let msg = tipo === 'quiniela' ? '🏆 RANKING QUINIELA\n' : '🏆 RANKING QUINIGOL\n';
  msg += `💰 Recaudación: ${recStr}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  ranking.forEach((r, i) => {
    const med = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const nom = r.nombre.length > 12 ? r.nombre.slice(0, 12) + '…' : r.nombre.padEnd(12);
    const pct = `${r.pct}%`.padStart(4);
    const viv = `${r.vivas}✅`.padEnd(5);
    const col = r.maxCat > 0 ? `Col:${r.maxCat}✓`.padEnd(8) : '        ';
    const prem = r.premioMax > 0 ? `~${r.premioMax.toLocaleString('es-ES')}€` : '';
    const rango = r.minCat !== r.maxCat ? `[${r.minCat}-${r.maxCat}]` : '';

    msg += `${med} ${nom} ${pct} ${viv} ${col} ${prem} ${rango}\n`;
  });

  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  // Tabla de premios estimados por categoría
  msg += `\n💶 Premios estimados por categoría:\n`;
  for (const pc of pcts) {
    const est = estimarPremio(rec?.recaudacion, rec?.bote, pc.categoria, pcts, tipo);
    if (est > 0) {
      msg += `  ${pc.categoria} aciertos → ${est.toLocaleString('es-ES')}€`;
      if (tipo === 'quiniela' && pc.categoria === 15 && (rec?.bote || 0) > 0) {
        msg += ` (+${rec.bote.toLocaleString('es-ES')}€ bote)`;
      }
      msg += '\n';
    }
  }

  return msg;
}

export function formatearRankingCompacto(tipo, partidos, premios) {
  const ranking = calcularRanking(tipo, partidos, premios);
  if (ranking.length === 0) return '';

  return ranking.map((r, i) => {
    const med = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const col = r.maxCat > 0 ? `Col${r.maxCat}✓` : '';
    const prem = r.premioMax > 0 ? `~${r.premioMax.toLocaleString('es-ES')}€` : '';
    return `${med} ${r.nombre}: ${r.pct}% ${r.vivas}✅ ${col} ${prem}`;
  }).join('\n');
}
