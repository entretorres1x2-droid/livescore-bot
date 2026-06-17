function evaluarGol(predicho, real) {
  if (predicho === '3+') return { vivo: true, correcto: real >= 3 };
  const p = parseInt(predicho);
  return { vivo: real <= p, correcto: real === p };
}

export function analizarColumnas(jugadas, partidos) {
  const resultados = partidos.map(p => ({
    local: p.golesLocal,
    visitante: p.golesVisitante,
    finalizado: p.finalizado || p.estado === 'post',
  }));

  return jugadas.map((raw, idx) => {
    const limpio = raw.trim().replace(/\s+/g, '');
    if (limpio.length < 12) return null;

    let aciertos = 0;
    let vivos = 0;
    let colViva = true;

    for (let i = 0; i < 6; i++) {
      const pLocal = limpio[i * 2].toUpperCase();
      const pVis = limpio[i * 2 + 1].toUpperCase();
      const res = resultados[i];

      if (!res || res.local === null || res.visitante === null) {
        vivos++;
        continue;
      }

      const loc = evaluarGol(pLocal, res.local);
      const vis = evaluarGol(pVis, res.visitante);

      if (res.finalizado) {
        if (loc.correcto && vis.correcto) aciertos++;
        else colViva = false;
      } else {
        if (loc.vivo && vis.vivo) vivos++;
        else colViva = false;
      }
    }

    const maxPosible = colViva ? aciertos + vivos : aciertos;
    return { num: idx + 1, raw: limpio, aciertos, viva: colViva, maxPosible };
  }).filter(Boolean);
}

export function resumenColumnas(jugadas, partidos) {
  const columnas = analizarColumnas(jugadas, partidos);
  const vivas = columnas.filter(c => c.viva);
  const muertas = columnas.filter(c => !c.viva);
  const maxGlobal = vivas.reduce((m, c) => Math.max(m, c.maxPosible), 0);
  return { columnas, vivas: vivas.length, muertas: muertas.length, maxCategoria: maxGlobal };
}

export function detectarMuertas(jugadas, partidosAnteriores, partidosActuales) {
  const antes = analizarColumnas(jugadas, partidosAnteriores);
  const ahora = analizarColumnas(jugadas, partidosActuales);
  const muertasNuevas = [];
  for (const a of ahora) {
    const b = antes.find(c => c.num === a.num);
    if (b && b.viva && !a.viva) {
      muertasNuevas.push(a);
    }
  }
  return muertasNuevas;
}
