/**
 * OpenClaw normal plugin entry for GBrain prompt context.
 *
 * Registers lifecycle hooks for resolver warmup/teardown and injects dynamic
 * Live Context plus Retrieval Reflex pointers through `before_prompt_build`.
 */

import { buildGBrainPromptContext } from './core/openclaw/prompt-context.ts';
import { disposeReflex, warmReflex } from './core/context/reflex.ts';

interface PluginEntry {
  id: string;
  name: string;
  description: string;
  register(api: PluginApi): void;
}

interface PluginApi {
  on(
    hookName: 'gateway_start',
    handler: (event: unknown, ctx: GatewayHookContext) => Promise<void> | void,
    opts?: HookOpts,
  ): void;
  on(
    hookName: 'before_prompt_build',
    handler: (event: BeforePromptBuildEvent, ctx: AgentHookContext) => Promise<BeforePromptBuildResult | void>,
    opts?: HookOpts,
  ): void;
  on(
    hookName: 'gateway_stop',
    handler: (event: unknown, ctx: GatewayHookContext) => Promise<void> | void,
    opts?: HookOpts,
  ): void;
}

interface HookOpts {
  priority?: number;
  timeoutMs?: number;
}

interface GatewayHookContext {
  workspaceDir?: string;
  [key: string]: unknown;
}

interface AgentHookContext {
  workspaceDir?: string;
  [key: string]: unknown;
}

interface BeforePromptBuildEvent {
  prompt?: string;
  messages?: unknown[];
}

interface BeforePromptBuildResult {
  prependContext?: string;
}

interface RuntimeState {
  workspaceDir: string;
  started: boolean;
}

const PROMPT_HOOK_TIMEOUT_MS = 1_600;
const LIFECYCLE_HOOK_TIMEOUT_MS = 2_500;
const state: RuntimeState = {
  workspaceDir: process.cwd(),
  started: false,
};

const entry: PluginEntry = {
  id: 'gbrain',
  name: 'GBrain',
  description: 'Dynamic GBrain Live Context and Retrieval Reflex prompt context',

  register(api: PluginApi) {
    api.on(
      'gateway_start',
      (_event, ctx) => {
        state.workspaceDir = resolveWorkspaceDir(ctx);
        state.started = true;
        warmReflex();
      },
      { timeoutMs: LIFECYCLE_HOOK_TIMEOUT_MS },
    );

    api.on(
      'before_prompt_build',
      async (event, ctx) => {
        const workspaceDir = state.started
          ? state.workspaceDir
          : resolveWorkspaceDir(ctx);
        const prependContext = await buildGBrainPromptContext({
          workspaceDir,
          prompt: event.prompt,
          messages: event.messages,
        });
        return prependContext ? { prependContext } : undefined;
      },
      { timeoutMs: PROMPT_HOOK_TIMEOUT_MS },
    );

    api.on(
      'gateway_stop',
      async () => {
        state.started = false;
        await disposeReflex();
      },
      { timeoutMs: LIFECYCLE_HOOK_TIMEOUT_MS },
    );
  },
};

function resolveWorkspaceDir(ctx: GatewayHookContext | AgentHookContext | undefined): string {
  return typeof ctx?.workspaceDir === 'string' && ctx.workspaceDir
    ? ctx.workspaceDir
    : process.cwd();
}

export default entry;
