// Цвет терминала вызывающего процесса не должен менять вывод subprocess-тестов.
export function subprocessEnv(overrides = {}, inherited = process.env) {
  const env = { ...inherited };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return { ...env, ...overrides };
}
