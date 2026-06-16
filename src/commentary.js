/**
 * Generador de comentarios graciosos e interesantes sobre las jugadas
 * Modos: 'simple' (comentarios prefijados) o 'openai' (IA real)
 */
import config from './config.js';

const frasesGol = [
  (g) => `⚽ ¡GOOOOOOL de ${g.equipo}! Se mueve el marcador en ${g.partido}`,
  (g) => `⚽ ${g.equipo} marca al minuto ${g.minuto}. ¡${g.golesLocal}-${g.golesVisitante}!`,
  (g) => `🔥 ¡${g.equipo} perfora la red! Minuto ${g.minuto}. ${g.partido}`,
  (g) => `🎯 ${g.equipo} ⚽ (${g.minuto}') — ¡esto se pone interesante!`,
];

const frasesMuerteQuiniela = [
  (j) => `💀 ¡Adiós, jugada #${j.idx}! Esperaba ${j.esperado} y fue ${j.real}.`,
  (j) => `😱 La jugada #${j.idx} acaba de morir. Esperaba ${j.esperado}.`,
  (j) => `🪦 #${j.idx} ha caído. Esperaba ${j.esperado} y fue ${j.real}.`,
];

const frasesMuerteQuinigol = [
  (j) => `💀 Quinigol #${j.idx} KO. Esperaba ${j.esperado}, va ${j.real}.`,
  (j) => `😬 Se complica la #${j.idx} de Quinigol: esperaba ${j.esperado} y va ${j.real}.`,
];

const frasesVivas = [
  (n) => `✅ Quedan ${n} jugadas vivas de Quiniela. ¡A seguir sufriendo!`,
  (n) => `🏆 ${n} columnas de Quiniela siguen con opciones de premio.`,
  (n) => `🙏 ${n} jugadas de Quiniela siguen vivas. La esperanza es lo último que se pierde.`,
];

function elegir(arr, ...args) {
  const f = arr[Math.floor(Math.random() * arr.length)];
  return typeof f === 'function' ? f(...args) : f;
}

export function generarComentarioGol(golInfo) {
  return elegir(frasesGol, golInfo);
}

export function generarComentarioMuerte(jugada, tipo) {
  if (tipo === 'quiniela') {
    return elegir(frasesMuerteQuiniela, jugada);
  }
  return elegir(frasesMuerteQuinigol, jugada);
}

export function generarComentarioVivas(nQuiniela, nQuinigol) {
  const partes = [];
  if (nQuiniela > 0) partes.push(elegir(frasesVivas, nQuiniela));
  if (nQuinigol > 0) partes.push(`${nQuinigol} jugadas de Quinigol siguen en pie.`);
  if (partes.length === 0) return 'Todas las jugadas se han quedado fuera. La jornada aún no ha empezado o no hay apuestas vivas.';
  return partes.join('\n');
}

export async function generarComentarioIA(golInfo, impacto) {
  if (config.AI_MODE !== 'openai' || !config.OPENAI_API_KEY) {
    return generarComentarioSimple(golInfo, impacto);
  }

  try {
    const prompt = `Eres un comentarista de fútbol gracioso y muy cafre para un bot de quinielas. 
Acaba de marcar un gol: ${golInfo.equipo} (${golInfo.minuto}') en ${golInfo.partido}. 
Quedan ${impacto.quiniela.vivas} jugadas de quiniela vivas y ${impacto.quiniela.muertas} muertas.
${impacto.quiniela.afectadas.length > 0 ? 'Jugadas muertas: ' + impacto.quiniela.afectadas.map(j => '#' + j.idx).join(', ') : ''}
Quedan ${impacto.quinigol.vivas} jugadas de quinigol vivas y ${impacto.quinigol.muertas} muertas.
Genera un comentario corto (máximo 2 líneas), gracioso y con personalidad, como si fueras un amigo en la peña.`;

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
    return generarComentarioSimple(golInfo, impacto);
  } catch {
    return generarComentarioSimple(golInfo, impacto);
  }
}

function generarComentarioSimple(golInfo, impacto) {
  const partes = [generarComentarioGol(golInfo)];

  for (const j of impacto.quiniela.afectadas.slice(0, 3)) {
    partes.push(generarComentarioMuerte(j, 'quiniela'));
  }

  for (const j of impacto.quinigol.afectadas.slice(0, 3)) {
    partes.push(generarComentarioMuerte(j, 'quinigol'));
  }

  const vivasQ = impacto.quiniela.vivas;
  const vivasG = impacto.quinigol.vivas;

  const restoQ = impacto.quiniela.afectadas.length - 3;
  const restoG = impacto.quinigol.afectadas.length - 3;
  if (restoQ > 0) partes.push(`... y ${restoQ} más de Quiniela`);
  if (restoG > 0) partes.push(`... y ${restoG} más de Quinigol`);

  partes.push(generarComentarioVivas(vivasQ, vivasG));

  return partes.join('\n');
}
