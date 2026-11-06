#!/usr/bin/env node
// Local media inspection and isolated work folders. No network, installs or CapCut writes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(program, args, timeout = 30000) {
  const r = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${program}: ${r.error?.message || r.stderr?.trim().slice(0, 900) || `exit ${r.status}`}`);
  return r.stdout;
}
const emit = x => console.log(JSON.stringify(x, null, 2));
function options(args, allowed) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!allowed.includes(name) || args[i + 1] === undefined || args[i + 1].startsWith('--') || Object.hasOwn(out, name)) {
      throw new Error(`Неизвестный, повторный или неполный параметр: ${name}`);
    }
    out[name] = args[i + 1];
  }
  return out;
}
function positive(value, label, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`Некорректный ${label}: ${value}`);
  return n;
}
function localFile(file) {
  if (!file || /^https?:/i.test(file)) throw new Error('Нужен путь к существующему локальному файлу.');
  const p = fs.realpathSync(path.resolve(file));
  if (!fs.statSync(p).isFile()) throw new Error(`Это не файл: ${p}`);
  return p;
}
function rational(x) {
  const [a, b = 1] = String(x ?? '0').split('/').map(Number);
  return b && Number.isFinite(a / b) ? a / b : 0;
}
function inspect(file) {
  const full = localFile(file);
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', full]));
  const v = j.streams?.find(s => s.codec_type === 'video');
  const a = j.streams?.find(s => s.codec_type === 'audio');
  const rotate = Number(v?.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0);
  const swapped = Math.abs(rotate % 180) === 90;
  const duration = Number(v?.duration ?? j.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Не удалось определить длительность: ${full}`);
  return {
    path: full, bytes: fs.statSync(full).size, duration_s: duration,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height,
      display_width: swapped ? v.height : v.width, display_height: swapped ? v.width : v.height,
      rotation: rotate, fps: rational(v.avg_frame_rate || v.r_frame_rate),
      fps_rational: v.avg_frame_rate, nominal_fps: rational(v.r_frame_rate),
      frames: Number.isFinite(Number(v.nb_frames)) ? Number(v.nb_frames) : null,
      pixel_format: v.pix_fmt } : null,
    audio: a ? { codec: a.codec_name, sample_rate: Number(a.sample_rate), channels: a.channels } : null,
  };
}
function doctor() {
  const checks = [{ tool: 'node', available: true, version: process.version }];
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try { checks.push({ tool, available: true, version: run(tool, ['-version'], 6000).split(/\r?\n/)[0] }); }
    catch (e) { checks.push({ tool, available: false, error: e.message,
      hint: /EPERM|EACCES/.test(e.message) ? 'Запуск запрещён средой; это не доказательство отсутствия программы. Проверьте разрешения, не переустанавливайте автоматически.' : 'Проверьте наличие программы и PATH.' }); }
  }
  emit({ checks, mcp: 'not_checked', asr: 'not_checked', installed_or_downloaded: false });
  if (checks.some(x => !x.available)) process.exitCode = 1;
}
function init(args) {
  const o = options(args, ['--source', '--reference', '--root', '--duration', '--fps']);
  if (!o['--source'] || !o['--reference']) throw new Error('init требует --source и --reference с конкретными файлами.');
  const source = inspect(o['--source']), reference = inspect(o['--reference']);
  if (!source.video || !reference.video) throw new Error('Исходник и референс должны содержать видео.');
  const same = process.platform === 'win32'
    ? source.path.toLowerCase() === reference.path.toLowerCase() : source.path === reference.path;
  if (same) throw new Error('Исходник и стилевой референс должны быть разными файлами.');
  const duration = positive(o['--duration'] ?? 30, 'duration', 86400);
  const fps = positive(o['--fps'] ?? (source.video.fps || 30), 'fps', 240);
  const root = path.resolve(o['--root'] ?? process.cwd());
  const jobs = path.join(root, '_монтаж');
  fs.mkdirSync(jobs, { recursive: true });
  let work;
  for (let i = 1; ; i++) {
    const candidate = path.join(jobs, `reel_${String(i).padStart(2, '0')}`);
    try { fs.mkdirSync(candidate); work = candidate; break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  for (const name of ['analysis', 'graphics', 'audio', 'generated', 'export']) fs.mkdirSync(path.join(work, name));
  const config = { schema_version: 1, mode: 'capcut-web', created_at: new Date().toISOString(),
    source, reference, target: { width: 1080, height: 1920, duration_s: duration, fps },
    budget: { status: 'not_specified', approved_credits: null }, capcut: { status: 'not_started' } };
  fs.writeFileSync(path.join(work, 'job.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  const template = fs.readFileSync(path.join(skill, 'references', 'state-template.md'), 'utf8');
  fs.writeFileSync(path.join(work, 'STATE.md'), `Создана рабочая папка: ${work}\nИсходник: ${source.path}\nРеференс: ${reference.path}\nАнализ, генерации, монтаж и экспорт ещё не выполнялись. Следующий шаг: полный анализ исходника и референса.\n\n${template}`, { flag: 'wx' });
  emit({ work_directory: work, job: path.join(work, 'job.json'), status: 'prepared_only' });
}
function verify(args) {
  const [file, ...rest] = args;
  const o = options(rest, ['--duration', '--fps', '--audio']);
  const duration = positive(o['--duration'] ?? 30, 'duration', 86400);
  const m = inspect(file), errors = [], warnings = [];
  const fps = positive(o['--fps'] ?? m.video?.fps ?? 30, 'fps', 240);
  if (o['--audio'] && !['required', 'optional'].includes(o['--audio'])) throw new Error('--audio: required или optional.');
  if (!m.video) errors.push('Отсутствует видеопоток.');
  else {
    if (m.video.width < 1080 || m.video.height < 1920) errors.push('Кодированное видео ниже 1080×1920.');
    if (Math.abs(m.video.width / m.video.height - 9 / 16) > 0.001) errors.push('Соотношение сторон не 9:16.');
    if (m.video.rotation % 360 !== 0) errors.push('Экспорт должен иметь вертикальные пиксельные размеры без поворота метаданными.');
    if (m.video.codec !== 'h264') errors.push('Видеокодек не H.264.');
    if (Math.abs(m.video.fps - fps) > 0.001) errors.push(`FPS отличается от заданного ${fps}.`);
    if (Math.abs(m.video.fps - m.video.nominal_fps) > 0.01) warnings.push('Средний и номинальный FPS различаются; проверить VFR и тайминг.');
    if (m.video.frames === null) warnings.push('Число кадров не записано; выполнена проверка длительности, а не подсчёт всех декодированных кадров.');
  }
  if (Math.abs(m.duration_s - duration) > 1 / fps + 0.00001) errors.push(`Длительность ${m.duration_s} с отличается от ${duration} с больше чем на кадр.`);
  if (!m.audio && o['--audio'] !== 'optional') errors.push('Отсутствует звук.');
  if (m.audio && m.audio.codec !== 'aac') errors.push('Аудиокодек не AAC.');
  if (path.extname(m.path).toLowerCase() !== '.mp4') errors.push('Файл должен иметь расширение .mp4.');
  emit({ technical_pass: errors.length === 0, media: m, errors, warnings,
    manual_review_required: ['история', 'речь и субтитры', 'стыки', 'соответствие референсу', 'качество и происхождение пикселей', 'баланс звука'] });
  if (errors.length) process.exitCode = 1;
}
try {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) {
    console.log('reel.mjs doctor | inspect <file> | init --source <file> --reference <file> [--root <dir> --duration 30 --fps 30] | verify <mp4> [--duration 30 --fps 30 --audio required|optional]');
  } else if (cmd === 'doctor') { if (args.length) throw new Error('doctor не принимает параметры.'); doctor(); }
  else if (cmd === 'inspect') { if (args.length !== 1) throw new Error('inspect требует один файл.'); emit(inspect(args[0])); }
  else if (cmd === 'init') init(args);
  else if (cmd === 'verify') verify(args);
  else throw new Error(`Неизвестная команда: ${cmd}`);
} catch (e) { console.error(JSON.stringify({ error: e.message })); process.exitCode = 1; }
