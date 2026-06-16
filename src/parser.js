/**
 * Parser de jugadas de Quiniela y Quinigol
 *
 * FORMATO QUINIELA: cada línea son 16 caracteres SIN espacios
 *   Caracteres 1-14: 1, X o 2 (14 partidos)
 *   Caracteres 15-16: pleno al 15 (goles local y visitante: 0,1,2,M)
 *   Ejemplo: 1X21X21X21X21M2 = 14 columnas 1X2 + pleno local=M visitante=2
 *   También compatible con formato antiguo separado por espacios
 *
 * FORMATO QUINIGOL: cada línea son 12 caracteres SIN espacios
 *   6 pares de 2 caracteres: golesLocal golesVisitante
 *   Valores: 0, 1, 2, M (tres o más)
 *   Ejemplo: 012M1011M200 = 0-1 2-M 1-0 1-1 M-2 0-0
 *   También compatible con formato antiguo separado por espacios
 */

const GOL_VALIDOS = ['0', '1', '2', 'M'];

function parsePleno(car1, car2) {
  const local = car1.toUpperCase();
  const visit = car2.toUpperCase();
  if (!GOL_VALIDOS.includes(local) || !GOL_VALIDOS.includes(visit)) return null;
  return { local: local === 'M' ? '3+' : local, visitante: visit === 'M' ? '3+' : visit };
}

export function parseQuinielaJugada(linea) {
  const limpio = linea.trim();

  // Formato nuevo: 16 caracteres sin espacios
  if (!limpio.includes(' ') && !limpio.includes('\t')) {
    if (limpio.length < 14) return null;

    const columnas = [];
    for (let i = 0; i < 14; i++) {
      const c = limpio[i].toUpperCase();
      if (c === '1') columnas.push(['1']);
      else if (c === 'X') columnas.push(['X']);
      else if (c === '2') columnas.push(['2']);
      else return null;
    }

    let pleno = null;
    if (limpio.length >= 16) {
      pleno = parsePleno(limpio[14], limpio[15]);
    }

    return { columnas, pleno };
  }

  // Formato antiguo: separado por espacios (con soporte de dobles/triples)
  const partes = limpio.split(/\s+/);
  if (partes.length < 14) return null;

  const columnas = partes.slice(0, 14).map(col => {
    const c = col.toUpperCase();
    const validos = [];
    if (c.includes('1')) validos.push('1');
    if (c.includes('X')) validos.push('X');
    if (c.includes('2')) validos.push('2');
    return validos.length > 0 ? validos : null;
  });

  if (columnas.some(c => c === null)) return null;

  let pleno = null;
  if (partes.length >= 16) {
    pleno = parsePleno(partes[14], partes[15]);
  }

  return { columnas, pleno };
}

export function parseQuinigolJugada(linea) {
  const limpio = linea.trim();

  // Formato nuevo: 12 caracteres sin espacios
  if (!limpio.includes(' ') && !limpio.includes('\t') && !limpio.includes('-') && !limpio.includes('–')) {
    if (limpio.length < 12) return null;

    const partidos = [];
    for (let i = 0; i < 12; i += 2) {
      const local = limpio[i].toUpperCase();
      const visit = limpio[i + 1].toUpperCase();

      if (!['0', '1', '2', 'M'].includes(local)) return null;
      if (!['0', '1', '2', 'M'].includes(visit)) return null;

      const gol = v => v === 'M' ? '3+' : v;
      partidos.push({ local: gol(local), visitante: gol(visit) });
    }

    return { partidos };
  }

  // Formato antiguo: separado por espacios (ej: 0-1 2-M 1-0)
  const partes = limpio.split(/\s+/);
  if (partes.length < 6) return null;

  const partidos = partes.slice(0, 6).map(par => {
    const m = par.match(/^([012M])\s*[-–]\s*([012M])$/i);
    if (!m) return null;
    const goles = v => v.toUpperCase() === 'M' ? '3+' : v;
    return { local: goles(m[1]), visitante: goles(m[2]) };
  });

  if (partidos.some(p => p === null)) return null;
  return { partidos };
}

export function parsearMultiplesJugadas(texto, tipo) {
  const lineas = texto.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('//'));

  return lineas.map((l, i) => {
    const res = tipo === 'quiniela' ? parseQuinielaJugada(l) : parseQuinigolJugada(l);
    return res ? { ...res, idx: i + 1, raw: l } : null;
  }).filter(Boolean);
}
