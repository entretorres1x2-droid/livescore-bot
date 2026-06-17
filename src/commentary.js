import config from './config.js';

const frasesGol = [
  (g) => `⚽ GOOOOL de ${g.equipo}! ${g.partido} (${g.minuto}')`,
  (g) => `⚽ ${g.equipo} marca al ${g.minuto}. ${g.golesLocal}-${g.golesVisitante}`,
  (g) => `🔥 ${g.equipo} perfora la red! (${g.minuto}')`,
  (g) => `🎯 GOLAZO de ${g.equipo} — ${g.golesLocal}-${g.golesVisitante}`,
];

const frasesMuerte = [
  (n) => `💀 Columna #${n} se queda fuera.`,
  (n) => `😬 Salta la #${n}. Se complica el Quinigol.`,
  (n) => `🪦 #${n} ha muerto.`,
  (n) => `✂️ Adiós, #${n}.`,
];

const frasesVivas = [
  (n, m) => `${n} columnas vivas. La mejor puede llegar a ${m} aciertos.`,
  (n, m) => `${n} siguen en pie. Categoría máxima posible: ${m}✓`,
  (n, m) => `${n} vivas ✅. A seguir soñando con ${m} aciertos.`,
];

function elegir(arr, ...args) {
  const f = arr[Math.floor(Math.random() * arr.length)];
  return f(...args);
}

export function generarComentarioGol(golInfo) {
  return elegir(frasesGol, golInfo);
}

export function generarComentarioInicio(partido) {
  return `🟢 COMENZÓ: ${partido.local} vs ${partido.visitante}`;
}

export function generarComentarioFinal(partido) {
  return `🏁 FINAL: ${partido.local} ${partido.golesLocal}-${partido.golesVisitante} ${partido.visitante}`;
}

export function generarComentarioMuertas(muertas) {
  if (muertas.length === 0) return '';
  return muertas.slice(0, 5).map(m => elegir(frasesMuerte, m.num)).join('\n');
}

export function generarComentarioEstado(vivas, muertas, maxCategoria) {
  if (vivas === 0 && muertas === 0) return 'No hay jugadas cargadas. Usa /jugada para subir tu archivo.';
  return `${elegir(frasesVivas, vivas, maxCategoria)}\nTotal: ${vivas} ✅ | ${muertas} 💀`;
}

export async function generarComentarioIA(golInfo, impacto) {
  if (config.AI_MODE !== 'openai' || !config.OPENAI_API_KEY) {
    const partes = [generarComentarioGol(golInfo)];
    if (impacto.muertas.length > 0) {
      partes.push(generarComentarioMuertas(impacto.muertas));
    }
    partes.push(generarComentarioEstado(impacto.vivas, impacto.total - impacto.vivas, impacto.maxCategoria));
    return partes.join('\n');
  }

  try {
    const prompt = `Eres un comentarista de fútbol gracioso y cafre para un bot de Quinigol.
Acaba de marcar ${golInfo.equipo} (${golInfo.minuto}') en ${golInfo.partido}. Marcador: ${golInfo.golesLocal}-${golInfo.golesVisitante}.
Quedan ${impacto.vivas} columnas vivas de ${impacto.total}. Las muertas son: ${impacto.muertas.map(m => '#' + m.num).join(', ')}.
Máxima categoría posible: ${impacto.maxCategoria} aciertos.
Genera 1-2 líneas graciosas y con personalidad, como un colega en la peña.`;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.9,
      }),
    });

    const data = await resp.json();
    if (data?.choices?.[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
    return generarComentarioGol(golInfo);
  } catch {
    return generarComentarioGol(golInfo);
  }
}
