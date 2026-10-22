import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function recipeBridge(request: unknown): Promise<Record<string, unknown>> {
  const database = resolve(process.env.RECIPES_DB ?? 'data/recipes.sqlite');
  const python = resolve(process.env.PYTHON_BIN ?? '.venv/bin/python');
  if (!existsSync(database)) return Promise.reject(new Error('База рецептов не найдена. Укажите RECIPES_DB в .env'));
  if (!existsSync(python)) return Promise.reject(new Error('Подготовьте поиск рецептов: npm run setup:recipes'));
  return new Promise((done, fail) => {
    const child = spawn(python, ['recipes/bridge.py', database], {
      env: { ...process.env, PYTHONPYCACHEPREFIX: resolve('data/pycache') }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); fail(new Error('Подбор занял слишком много времени. Уменьшите число продуктов.')); }, 45000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.resume();
    child.on('error', error => { clearTimeout(timeout); fail(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        const result = JSON.parse(output);
        if (code || result.error) fail(new Error(result.error ?? 'Поиск рецептов недоступен'));
        else done(result);
      } catch { fail(new Error('Не удалось прочитать ответ поиска')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
