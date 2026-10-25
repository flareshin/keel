import { performance } from 'node:perf_hooks';
import { runProcessGroup, TimeoutExpired } from '../evidence/subprocess.ts';

export type TestFileRun =
  | { outcome: 'completed'; returncode: number; passed: number; durationMs: number; output: string }
  | { outcome: 'timeout'; output: string };

const PARENT_TEST_RUNNER = 'NODE_TEST_CONTEXT';
const TAP_PASS_COUNT = /^# pass ([0-9]+)$/mu;

export async function runTestFile(directory: string, test: string, timeoutSeconds: number, env: NodeJS.ProcessEnv = {}): Promise<TestFileRun> {
  const started = performance.now();
  try {
    const completed = await runProcessGroup([process.execPath, '--test', '--test-reporter=tap', test], {
      cwd: directory,
      env: { ...withoutParentTestRunner(process.env), ...env },
      timeoutSeconds,
    });
    const stdout = completed.stdout.toString();
    const passed = Number(TAP_PASS_COUNT.exec(stdout)?.[1] ?? 0);
    return { outcome: 'completed', returncode: completed.returncode, passed, durationMs: performance.now() - started, output: stdout + completed.stderr.toString() };
  } catch (error) {
    if (error instanceof TimeoutExpired) return { outcome: 'timeout', output: error.message };
    throw error;
  }
}

function withoutParentTestRunner(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [PARENT_TEST_RUNNER]: _parent, ...rest } = env;
  return rest;
}
