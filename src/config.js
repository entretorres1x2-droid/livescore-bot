import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN no definido');
}

const JUGADAS_FILE = join(__dirname, '..', 'datos', 'quinigol.txt');

export function cargarJugadas() {
  try {
    if (!existsSync(JUGADAS_FILE)) return [];
    const content = readFileSync(JUGADAS_FILE, 'utf-8');
    return content.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('//') && l.length >= 12);
  } catch {
    return [];
  }
}

export default {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TEMPORADA: process.env.TEMPORADA || '2026',
  JORNADA_QUINIGOL: process.env.JORNADA_QUINIGOL || '78',
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 60,
  AI_MODE: process.env.AI_MODE || 'simple',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};
