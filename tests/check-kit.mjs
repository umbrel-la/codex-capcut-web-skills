// Offline integration checks. Synthetic media only; no real CapCut project or paid API.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-reels-test-'));
const utility = path.join(kit, '.agents/skills/reel-director/scripts/reel.mjs');
const checks = [];
function command(program, args, cwd = work, env = process.env) {
  const r = spawnSync(program, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}
function cli(args) { return command(process.execPath, [utility, ...args]); }
function passed(name) { checks.push(name); }
function sample(file, size, audio) {
  const args = ['-v', 'error', '-n', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:r=30:d=1`];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac');
  args.push('-t', '1', file);
  const r = command('ffmpeg', args);
  assert.equal(r.status, 0, r.stderr);
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(x => x.isDirectory() ? walk(path.join(dir, x.name)) : [path.join(dir, x.name)]);
}
try {
  const good = path.join(work, 'исходник & пробел.mp4');
  const low = path.join(work, 'reference-720.mp4');
  const silent = path.join(work, 'silent.mp4');
  sample(good, '1080x1920', true); sample(low, '720x1280', true); sample(silent, '1080x1920', false);
  let r = cli(['verify', good, '--duration', '1', '--fps', '30']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(JSON.parse(r.stdout).technical_pass, true); passed('1080x1920 H.264/AAC passes; Unicode, spaces and & paths work');
  for (const [args, error] of [
    [['verify', low, '--duration', '1', '--fps', '30'], '1080'],
    [['verify', good, '--duration', '30', '--fps', '30'], 'Длительность'],
    [['verify', good, '--duration', '1', '--fps', '60'], 'FPS'],
    [['verify', silent, '--duration', '1', '--fps', '30'], 'звук'],
  ]) {
    r = cli(args); assert.equal(r.status, 1); assert.ok(JSON.parse(r.stdout).errors.some(x => x.includes(error)));
  }
  passed('Rejects 720p, wrong duration, wrong FPS and missing required audio');
  r = cli(['verify', silent, '--duration', '1', '--fps', '30', '--audio', 'optional']); assert.equal(r.status, 0);
  passed('Explicit silent-video verification works');
  const args = ['init', '--source', good, '--reference', low, '--root', work, '--duration', '30', '--fps', '30'];
  r = cli(args); assert.equal(r.status, 0, r.stderr); const first = JSON.parse(r.stdout).work_directory;
  const state = fs.readFileSync(path.join(first, 'STATE.md'), 'utf8');
  r = cli(args); assert.equal(r.status, 0, r.stderr); const second = JSON.parse(r.stdout).work_directory;
  assert.notEqual(first, second); assert.equal(fs.readFileSync(path.join(first, 'STATE.md'), 'utf8'), state);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first, 'job.json'))).source.path, fs.realpathSync(good));
  assert.equal(cli(['init', '--source', good, '--reference', good, '--root', work]).status, 1);
  assert.equal(cli(['init', '--source', good, '--reference', low, '--root', work, '--duration', 'NaN']).status, 1);
  assert.equal(fs.readdirSync(path.join(work, '_монтаж')).length, 2);
  passed('Job allocation preserves existing work and rejects invalid inputs before creating a job');
  const syntaxFiles = walk(path.join(kit, '.agents/skills')).filter(f => f.endsWith('.mjs'));
  for (const f of syntaxFiles) { r = command(process.execPath, ['--check', f]); assert.equal(r.status, 0, `${f}\n${r.stderr}`); }
  passed(`JavaScript syntax: ${syntaxFiles.length} files`);
  const report = { passed: true, checked_at: new Date().toISOString(), checks, test_artifacts: work,
    not_tested: ['real CapCut desktop projects', 'CapCut/Higgsfield authorization and online editing', 'paid APIs', 'Remotion installation and TSX rendering'] };
  fs.mkdirSync(path.join(kit, '.validation'), { recursive: true });
  fs.writeFileSync(path.join(kit, '.validation', 'checks.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) { console.error(e.stack); console.error(`Synthetic test artifacts: ${work}`); process.exitCode = 1; }
