import { parseQuinielaJugada, parseQuinigolJugada } from './parser.js';
import config from './config.js';

const rango = g => g >= 3 ? '3+' : String(g);

export function analizarQuiniela(resultado, jugada, idxPartido) {
  const res = resultado[idxPartido];
  if (!res) return { viva: true, aciertos: 0 };

  // Si el partido no ha empezado (score null), no se puede analizar
  if (res.local === null || res.visitante === null) return { viva: true, aciertos: 0 };

  // Pleno al 15 (partido 15 = índice 14): comparar goles
  if (idxPartido === 14) {
    if (!jugada.pleno) return { viva: true, aciertos: 0 };
    const aciertaLocal = jugada.pleno.local === rango(res.local);
    const aciertaVisit = jugada.pleno.visitante === rango(res.visitante);
    return {
      viva: aciertaLocal && aciertaVisit,
      aciertos: (aciertaLocal && aciertaVisit) ? 1 : 0,
      esperado: `${jugada.pleno.local}-${jugada.pleno.visitante}`,
      real: `${rango(res.local)}-${rango(res.visitante)}`,
    };
  }

  // Partidos 1-14 (índices 0-13): 1X2
  const col = jugada.columnas[idxPartido];
  if (!col) return { viva: true, aciertos: 0 };

  let resultadoReal;
  if (res.local > res.visitante) resultadoReal = '1';
  else if (res.local < res.visitante) resultadoReal = '2';
  else resultadoReal = 'X';

  const acierta = col.includes(resultadoReal);
  return {
    viva: acierta,
    aciertos: acierta ? 1 : 0,
    esperado: col.join('/'),
    real: resultadoReal,
  };
}

export function analizarQuinigol(resultado, jugada, idxPartido) {
  const par = jugada.partidos[idxPartido];
  if (!par) return { viva: true, aciertos: 0, detalle: '' };

  const res = resultado[idxPartido];
  if (!res) return { viva: true, aciertos: 0, detalle: '' };
  if (res.local === null || res.visitante === null) return { viva: true, aciertos: 0, detalle: '' };

  const aciertaLocal = par.local === rango(res.local);
  const aciertaVisit = par.visitante === rango(res.visitante);

  const acierta = aciertaLocal && aciertaVisit;
  return {
    viva: acierta,
    aciertos: acierta ? 1 : 0,
    localAcierta: aciertaLocal,
    visitAcierta: aciertaVisit,
    esperado: `${par.local}-${par.visitante}`,
    real: `${rango(res.local)}-${rango(res.visitante)}`,
  };
}

export function analizarImpacto(golInfo, partidosQuiniela, partidosQuinigol, jugadasQuiniela, jugadasQuinigol) {
  const resultadosQ = partidosQuiniela.map(p => ({ local: p.golesLocal, visitante: p.golesVisitante }));
  const resultadosG = partidosQuinigol.map(p => ({ local: p.golesLocal, visitante: p.golesVisitante }));

  const idxQ = partidosQuiniela.findIndex(p => p.id === golInfo.id);
  const idxG = partidosQuinigol.findIndex(p => p.id === golInfo.id);

  const impacto = {
    gol: golInfo,
    quiniela: { vivas: 0, muertas: 0, afectadas: [] },
    quinigol: { vivas: 0, muertas: 0, afectadas: [] },
  };

  if (idxQ >= 0) {
    for (const jugada of jugadasQuiniela) {
      const res = analizarQuiniela(resultadosQ, jugada, idxQ);
      if (!res.viva) {
        impacto.quiniela.muertas++;
        impacto.quiniela.afectadas.push({
          idx: jugada.idx,
          raw: jugada.raw,
          esperado: res.esperado,
          real: res.real,
        });
      } else {
        impacto.quiniela.vivas++;
      }
    }
  }

  if (idxG >= 0) {
    for (const jugada of jugadasQuinigol) {
      const res = analizarQuinigol(resultadosG, jugada, idxG);
      if (!res.viva) {
        impacto.quinigol.muertas++;
        impacto.quinigol.afectadas.push({
          idx: jugada.idx,
          raw: jugada.raw,
          esperado: res.esperado,
          real: res.real,
        });
      } else {
        impacto.quinigol.vivas++;
      }
    }
  }

  return impacto;
}

export function resumenJugadasVivas(partidosQuiniela, partidosQuinigol, jugadasQuiniela, jugadasQuinigol) {
  const resultadosQ = partidosQuiniela.map(p => ({ local: p.golesLocal, visitante: p.golesVisitante }));
  const resultadosG = partidosQuinigol.map(p => ({ local: p.golesLocal, visitante: p.golesVisitante }));

  const vivasQ = [];
  for (const jugada of jugadasQuiniela) {
    let viva = true;
    let aciertos = 0;
    for (let i = 0; i < Math.min(resultadosQ.length, 15); i++) {
      const res = analizarQuiniela(resultadosQ, jugada, i);
      if (!res.viva) { viva = false; break; }
      if (res.aciertos > 0) aciertos++;
    }
    if (viva) {
      vivasQ.push({ idx: jugada.idx, raw: jugada.raw, aciertos });
    }
  }

  const vivasG = [];
  for (const jugada of jugadasQuinigol) {
    let viva = true;
    for (let i = 0; i < Math.min(resultadosG.length, 6); i++) {
      const res = analizarQuinigol(resultadosG, jugada, i);
      if (!res.viva) { viva = false; break; }
    }
    if (viva) vivasG.push({ idx: jugada.idx, raw: jugada.raw });
  }

  return { quiniela: vivasQ, quinigol: vivasG };
}
