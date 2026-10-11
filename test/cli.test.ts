import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8', env, shell: true, timeout: 60_000 });

describe('cli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf2video-cli-'));
  const workDir = join(dir, 'work');

  it('--help works', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--no-review');
  });

  it('missing GOOGLE_AI: exit 1, names the variable, no stack', () => {
    const env = { ...process.env };
    delete env.GOOGLE_AI;
    const r = run(['test/fixtures/sample.pdf', '--yes', '--no-review', '--work-dir', workDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('GOOGLE_AI');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('non-PDF file: clean error', () => {
    const file = join(dir, 'x.pdf');
    writeFileSync(file, 'hello');
    const r = run(['plan', file, '--yes', '--work-dir', workDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not a PDF');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});
