import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('⚠️ TELEGRAM_BOT_TOKEN no está definido. El bot no arrancará.');
}

console.log('📁 CWD:', process.cwd());
console.log('🔍 TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? '✓ presente' : '✗ ausente');
console.log('🔍 PORT:', process.env.PORT || '8080 (default)');
console.log('🔍 TEMPORADA:', process.env.TEMPORADA || '2026 (default)');

function loadJugadas(tipo) {
  const filePath = join(__dirname, '..', 'datos', `jugadas_${tipo}.txt`);
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
  } catch {
    return [];
  }
}

export default {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TEMPORADA: process.env.TEMPORADA || '2026',
  JORNADA_QUINIELA: process.env.JORNADA_QUINIELA || '46',
  JORNADA_QUINIGOL: process.env.JORNADA_QUINIGOL || '56',
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 60,
  AI_MODE: process.env.AI_MODE || 'simple',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  quinielaJugadas: loadJugadas('quiniela'),
  quinigolJugadas: loadJugadas('quinigol'),
};
