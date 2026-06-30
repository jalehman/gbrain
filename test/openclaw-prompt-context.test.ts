import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import {
  buildGBrainPromptContextParts,
  normalizeHookMessages,
} from '../src/core/openclaw/prompt-context.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-prompt-context-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'heartbeat-state.json'), '{}');
  writeFileSync(join(dir, 'memory', 'upcoming-flights.json'), '{}');
  return dir;
}

async function seed(slug: string, title: string, body: string) {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, 'default', 'person', $2, $3, '')`,
    [slug, title, body],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM page_aliases').catch(() => {});
  await engine.executeRaw('DELETE FROM pages');
});

describe('OpenClaw prompt-context builder', () => {
  test('normalizes hook messages and appends the raw prompt when absent', () => {
    const messages = normalizeHookMessages(
      [{ role: 'assistant', content: 'Alice Example may be relevant.' }],
      'what did she invest in?',
    );
    expect(messages).toEqual([
      { role: 'assistant', content: 'Alice Example may be relevant.' },
      { role: 'user', content: 'what did she invest in?' },
    ]);
  });

  test('does not append a duplicate prompt already present as a user message', () => {
    const messages = normalizeHookMessages(
      [{ role: 'user', content: 'tell me about Alice Example' }],
      'tell me about Alice Example',
    );
    expect(messages).toHaveLength(1);
  });

  test('builds prependContext with Live Context and prompt-appended Retrieval Reflex', async () => {
    const workspaceDir = makeWorkspace();
    try {
      await withEnv({ GBRAIN_RETRIEVAL_REFLEX: 'true' }, async () => {
        await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
        const result = await buildGBrainPromptContextParts({
          workspaceDir,
          prompt: 'what do you think about Alice Example?',
          messages: [],
          resolveEntities: (candidates, opts) =>
            resolveEntitiesToPointers(engine, 'default', candidates, opts),
        });
        expect(result.liveContext).toContain('Live Context');
        expect(result.reflexContext).toContain('people/alice-example');
        expect(result.text).toContain('Brain pages mentioned this turn');
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
