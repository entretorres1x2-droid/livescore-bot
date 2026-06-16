import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseQuinielaJugada, parseQuinigolJugada } from './parser.js';
import { analizarQuiniela, analizarQuinigol } from './analyzer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PENAS_FILE = join(__dirname, '..', 'datos', 'penas.json');

let penas = [];

function load() {
  try {
    if (existsSync(PENAS_FILE)) {
      penas = JSON.parse(readFileSync(PENAS_FILE, 'utf-8'));
    }
  } catch {}
}
function save() {
  const dir = join(__dirname, '..', 'datos');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PENAS_FILE, JSON.stringify(penas, null, 2));
}

load();

export function listarPenas() {
  return penas.map(p => ({
    nombre: p.nombre,
    tipo: p.tipo,
    total: p.jugadas.length,
  }));
}

export function crearPena(nombre, tipo) {
  if (penas.find(p => p.nombre.toLowerCase() === nombre.toLowerCase())) {
    return { ok: false, error: 'Ya existe una peña con ese nombre' };
  }
  penas.push({ nombre, tipo, jugadas: [] });
  save();
  return { ok: true };
}

export function eliminarPena(nombre) {
  const idx = penas.findIndex(p => p.nombre.toLowerCase() === nombre.toLowerCase());
  if (idx < 0) return { ok: false, error: 'Peña no encontrada' };
  penas.splice(idx, 1);
  save();
  return { ok: true };
}

export function cargarJugadasPena(nombre, lineas) {
  const pena = penas.find(p => p.nombre.toLowerCase() === nombre.toLowerCase());
  if (!pena) return { ok: false, error: 'Peña no encontrada' };

  const parseFn = pena.tipo === 'quiniela' ? parseQuinielaJugada : parseQuinigolJugada;
  const jugadas = lineas.map(l => parseFn(l)).filter(Boolean);
  if (jugadas.length === 0) return { ok: false, error: 'No se pudo parsear ninguna jugada' };

  pena.jugadas = lineas;
  save();
  return { ok: true, total: jugadas.length };
}

export function obtenerPena(nombre) {
  return penas.find(p => p.nombre.toLowerCase() === nombre.toLowerCase());
}

export function escrutarPena(nombre, partidos) {
  const pena = penas.find(p => p.nombre.toLowerCase() === nombre.toLowerCase());
  if (!pena) return null;

  const parseFn = pena.tipo === 'quiniela' ? parseQuinielaJugada : parseQuinigolJugada;
  const analizar = pena.tipo === 'quiniela' ? analizarQuiniela : analizarQuinigol;

  const resultados = partidos.map(p => ({
    local: p.golesLocal,
    visitante: p.golesVisitante,
  }));

  const parsed = pena.jugadas.map(j => parseFn(j)).filter(Boolean);
  const escrutinio = parsed.map((jugada, idx) => {
    let aciertos = 0;
    let viva = true;
    for (let i = 0; i < resultados.length; i++) {
      const res = analizar(resultados, jugada, i);
      if (!res.viva) viva = false;
      if (res.aciertos > 0) aciertos += res.aciertos;
    }
    return { idx: idx + 1, raw: pena.jugadas[idx], aciertos, viva };
  });

  const categorias = {};
  for (let i = 0; i <= resultados.length; i++) categorias[i] = { count: 0, positions: [] };
  for (const e of escrutinio) {
    categorias[e.aciertos].count++;
    categorias[e.aciertos].positions.push(e.idx);
  }

  const vivas = escrutinio.filter(e => e.viva).length;
  const muertas = escrutinio.filter(e => !e.viva).length;

  return { nombre: pena.nombre, tipo: pena.tipo, total: escrutinio.length, vivas, muertas, categorias, escrutinio };
}

export function escrutarTodas(partidosQuiniela, partidosQuinigol) {
  return penas.map(p => {
    const partidos = p.tipo === 'quiniela' ? partidosQuiniela : partidosQuinigol;
    return escrutarPena(p.nombre, partidos);
  }).filter(Boolean);
}
