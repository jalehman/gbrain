import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pluginEntry from '../src/openclaw-plugin.ts';
import { withEnv } from './helpers/with-env.ts';

interface HookCall {
  hookName: string;
  handler: (event: any, ctx: any) => any;
  opts?: { timeoutMs?: number };
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-plugin-hooks-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'heartbeat-state.json'), '{}');
  writeFileSync(join(dir, 'memory', 'upcoming-flights.json'), '{}');
  return dir;
}

describe('openclaw normal plugin entry', () => {
  test('registers lifecycle and prompt hooks', () => {
    const calls: HookCall[] = [];
    pluginEntry.register({
      on: (hookName: string, handler: HookCall['handler'], opts?: HookCall['opts']) => {
        calls.push({ hookName, handler, opts });
      },
    } as never);

    expect(pluginEntry.id).toBe('gbrain');
    expect(calls.map((call) => call.hookName)).toEqual([
      'gateway_start',
      'before_prompt_build',
      'gateway_stop',
    ]);
    expect(calls.find((call) => call.hookName === 'before_prompt_build')?.opts?.timeoutMs).toBe(1600);
  });

  test('before_prompt_build returns dynamic context through prependContext', async () => {
    const calls: HookCall[] = [];
    const workspaceDir = makeWorkspace();
    try {
      await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'false' }, async () => {
        pluginEntry.register({
          on: (hookName: string, handler: HookCall['handler'], opts?: HookCall['opts']) => {
            calls.push({ hookName, handler, opts });
          },
        } as never);

        await calls.find((call) => call.hookName === 'gateway_start')!.handler({}, { workspaceDir });
        const result = await calls.find((call) => call.hookName === 'before_prompt_build')!.handler(
          { prompt: 'hello', messages: [] },
          { workspaceDir: '/tmp/ignored-after-start' },
        );

        expect(result.prependContext).toContain('Live Context');
        expect(result.systemPrompt).toBeUndefined();
        expect(result.prependSystemContext).toBeUndefined();
        await calls.find((call) => call.hookName === 'gateway_stop')!.handler({}, { workspaceDir });
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
