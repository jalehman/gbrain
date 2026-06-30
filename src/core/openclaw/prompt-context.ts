/**
 * Pure GBrain prompt-context builder for OpenClaw normal prompt hooks.
 *
 * This module intentionally avoids OpenClaw SDK imports. The plugin entry can
 * call it from `before_prompt_build`, while the legacy context-engine wrapper
 * can keep using its own OpenClaw runtime delegation path.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildReflexAddition, type ResolveEntitiesFn as ReflexResolveEntitiesFn } from '../context/reflex.ts';

export interface PromptContextMessage {
  role: string;
  content: string | unknown;
  [key: string]: unknown;
}

export interface BuildGBrainPromptContextParams {
  workspaceDir?: string;
  prompt?: string;
  messages?: unknown[];
  resolveEntities?: ReflexResolveEntitiesFn;
}

export interface GBrainPromptContextParts {
  liveContext: string;
  reflexContext: string | null;
  text: string;
}

interface HeartbeatState {
  garryAwake?: boolean;
  currentLocation?: {
    city?: string;
    state?: string;
    province?: string;
    country?: string;
    timezone?: string;
    source?: string;
    note?: string;
  };
}

interface FlightData {
  flights?: Array<{
    status?: string;
    origin?: string;
    destination?: string;
    flightNumber?: string;
    note?: string;
  }>;
}

interface CalendarEvent {
  id?: string;
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  attendees?: string[];
}

interface CalendarCache {
  lastUpdated?: string;
  events?: CalendarEvent[];
}

interface LiveContext {
  now: string | null;
  timezone: string;
  dayOfWeek: string | null;
  homeTime: string | null;
  location: {
    city: string;
    tz: string;
    source: string;
  };
  userAwake: boolean;
  wallClockQuietHours: boolean;
  quietHoursActive: boolean;
  activeTravel: string | null;
  currentEvent: CalendarEvent | null;
  nextEvents: CalendarEvent[];
  todayTasks: string[];
  calendarStale: boolean;
}

const AIRPORT_TZ: Record<string, string> = {
  SFO: 'US/Pacific', LAX: 'US/Pacific', SJC: 'US/Pacific', SEA: 'US/Pacific', PDX: 'US/Pacific',
  JFK: 'US/Eastern', LGA: 'US/Eastern', EWR: 'US/Eastern', BOS: 'US/Eastern',
  DCA: 'US/Eastern', IAD: 'US/Eastern', MIA: 'US/Eastern', ATL: 'US/Eastern',
  ORD: 'US/Central', DFW: 'US/Central', IAH: 'US/Central', AUS: 'US/Central',
  DEN: 'US/Mountain', PHX: 'US/Arizona',
  HNL: 'Pacific/Honolulu',
  YYZ: 'America/Toronto', YVR: 'America/Vancouver', YUL: 'America/Montreal',
  NRT: 'Asia/Tokyo', HND: 'Asia/Tokyo', ICN: 'Asia/Seoul',
  SIN: 'Asia/Singapore', HKG: 'Asia/Hong_Kong', TPE: 'Asia/Taipei',
  LHR: 'Europe/London', CDG: 'Europe/Paris', FCO: 'Europe/Rome',
  LIS: 'Europe/Lisbon', BCN: 'Europe/Madrid',
};

const DEFAULT_TZ = 'US/Pacific';
const DEFAULT_HOME = 'San Francisco';
const UNKNOWN_TZ = 'UNKNOWN';
const WINDOW_TURNS_HARD_CAP = 12;
const MAX_TASKS_MD_BYTES = 1_000_000;

/**
 * Build the dynamic GBrain context text for an OpenClaw prompt hook.
 */
export async function buildGBrainPromptContext(
  params: BuildGBrainPromptContextParams,
): Promise<string> {
  return (await buildGBrainPromptContextParts(params)).text;
}

/**
 * Build the dynamic GBrain context and expose its component blocks for tests.
 */
export async function buildGBrainPromptContextParts(
  params: BuildGBrainPromptContextParams,
): Promise<GBrainPromptContextParts> {
  const workspaceDir = params.workspaceDir ?? process.cwd();
  const messages = normalizeHookMessages(params.messages, params.prompt);
  const liveContext = formatContextBlock(generateLiveContext(workspaceDir));
  const reflexContext = await buildReflexAddition({
    workspaceDir,
    currentUserText: getLastUserText(messages),
    priorContextText: getPriorContextText(messages),
    windowTurns: getWindowTurns(messages),
    resolveEntities: params.resolveEntities,
  });
  const parts = [liveContext];
  if (reflexContext) parts.push(reflexContext);
  return { liveContext, reflexContext, text: parts.join('\n\n') };
}

/**
 * Normalize OpenClaw hook messages and append the raw prompt when absent.
 */
export function normalizeHookMessages(
  messages: unknown[] | undefined,
  prompt?: string,
): PromptContextMessage[] {
  const normalized = Array.isArray(messages)
    ? messages.map(normalizeHookMessage).filter((m): m is PromptContextMessage => m !== null)
    : [];
  const promptText = messageText(prompt).trim();
  if (!promptText) return normalized;

  const promptAlreadyPresent = normalized.some((message) =>
    message.role === 'user' && messageText(message.content).trim() === promptText,
  );
  if (!promptAlreadyPresent) {
    normalized.push({ role: 'user', content: promptText });
  }
  return normalized;
}

/**
 * Estimate message token count using the legacy context-engine approximation.
 */
export function estimatePromptContextMessageTokens(messages: PromptContextMessage[]): number {
  return messages.reduce((sum, message) => {
    const text = typeof message.content === 'string'
      ? message.content
      : (JSON.stringify(message.content) ?? '');
    return sum + Math.ceil(text.length / 4);
  }, 0);
}

function normalizeHookMessage(value: unknown): PromptContextMessage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : 'unknown';
  return {
    ...record,
    role,
    content: record.content,
  };
}

function loadJsonFile<T = unknown>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sanitizeForPrompt(s: string, maxLen: number = 100): string {
  return s.replace(/[\n\r\t\x00-\x1F\x7F]/g, ' ').slice(0, maxLen).trim();
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function getLastUserText(messages: PromptContextMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messageText(messages[i].content);
  }
  return '';
}

function getWindowTurns(messages: PromptContextMessage[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (let i = messages.length - 1; i >= 0 && out.length < WINDOW_TURNS_HARD_CAP; i--) {
    const message = messages[i];
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    const text = messageText(message.content);
    if (!text) continue;
    out.push({ role: message.role, text });
  }
  return out.reverse();
}

function getPriorContextText(messages: PromptContextMessage[]): string {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const parts: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (i === lastUserIdx) continue;
    const text = messageText(messages[i]?.content);
    if (text) parts.push(text);
  }
  return parts.join('\n').slice(-20_000);
}

function getTimeInTz(tz: string): { iso: string; dayOfWeek: string; hour: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';

  const utcH = now.getUTCHours();
  const localH = parseInt(get('hour'));
  let offset = localH - utcH;
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const offsetStr = `${sign}${String(abs).padStart(2, '0')}:00`;

  const iso = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offsetStr}`;
  const dayOfWeek = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });

  return { iso, dayOfWeek, hour: localH };
}

function resolveLocation(
  hb: HeartbeatState | null,
  flights: FlightData | null,
): { city: string; tz: string; source: string } {
  if (hb?.currentLocation?.timezone) {
    return {
      city: hb.currentLocation.city ?? DEFAULT_HOME,
      tz: hb.currentLocation.timezone,
      source: hb.currentLocation.source ?? 'heartbeat',
    };
  }

  const active = flights?.flights?.find(f => f.status === 'active');
  if (active?.destination) {
    const destUpper = active.destination.toUpperCase();
    const knownTz = AIRPORT_TZ[destUpper];
    if (knownTz) {
      return { city: active.destination, tz: knownTz, source: `flight:${active.flightNumber}` };
    }
    return {
      city: hb?.currentLocation?.city ?? active.destination,
      tz: UNKNOWN_TZ,
      source: `flight:${active.flightNumber}:tz-unknown:${destUpper}`,
    };
  }

  return { city: DEFAULT_HOME, tz: DEFAULT_TZ, source: 'default' };
}

function parseEventTime(timeStr: string | undefined): Date | null {
  if (!timeStr) return null;
  const d = new Date(timeStr);
  return isNaN(d.getTime()) ? null : d;
}

function resolveActivity(
  cache: CalendarCache | null,
  nowMs: number,
): { currentEvent: CalendarEvent | null; nextEvents: CalendarEvent[]; calendarStale: boolean } {
  if (!cache?.events?.length) {
    return { currentEvent: null, nextEvents: [], calendarStale: true };
  }

  const lastUpdated = cache.lastUpdated ? new Date(cache.lastUpdated).getTime() : 0;
  const calendarStale = (nowMs - lastUpdated) > 6 * 60 * 60 * 1000;
  const lookaheadMs = 4 * 60 * 60 * 1000;
  let currentEvent: CalendarEvent | null = null;
  const nextEvents: CalendarEvent[] = [];

  for (const evt of cache.events) {
    if (evt.start && !evt.start.includes('T')) continue;
    if (!evt.summary) continue;
    const lower = evt.summary.toLowerCase();
    if (lower === 'home' || lower === 'ooo' || lower.startsWith('out of office')) continue;

    const startMs = parseEventTime(evt.start)?.getTime();
    const endMs = parseEventTime(evt.end)?.getTime();
    if (!startMs) continue;

    if (startMs <= nowMs && endMs && endMs > nowMs) {
      if (!currentEvent) currentEvent = evt;
      continue;
    }

    if (startMs > nowMs && startMs <= nowMs + lookaheadMs) {
      nextEvents.push(evt);
    }
  }

  nextEvents.sort((a, b) => {
    const aMs = parseEventTime(a.start)?.getTime() ?? 0;
    const bMs = parseEventTime(b.start)?.getTime() ?? 0;
    return aMs - bMs;
  });

  return { currentEvent, nextEvents: nextEvents.slice(0, 3), calendarStale };
}

function resolveTodayTasks(workspaceDir: string): string[] {
  try {
    const path = join(workspaceDir, 'ops', 'tasks.md');
    if (statSync(path).size > MAX_TASKS_MD_BYTES) return [];
    const raw = readFileSync(path, 'utf8');
    const todayMatch = raw.match(/## Today[\s\S]*?(?=\n## |$)/);
    if (!todayMatch) return [];

    const open: string[] = [];
    for (const line of todayMatch[0].split('\n')) {
      const match = line.match(/^\s*-\s*\[ \]\s*\*\*(.+?)\*\*/);
      if (match) open.push(sanitizeForPrompt(match[1].trim()));
    }
    return open.slice(0, 5);
  } catch {
    return [];
  }
}

function generateLiveContext(workspaceDir: string): LiveContext {
  const hb = loadJsonFile<HeartbeatState>(join(workspaceDir, 'memory', 'heartbeat-state.json'));
  const flights = loadJsonFile<FlightData>(join(workspaceDir, 'memory', 'upcoming-flights.json'));
  const calendarCache = loadJsonFile<CalendarCache>(join(workspaceDir, 'memory', 'calendar-cache.json'));

  const location = resolveLocation(hb, flights);
  const nowMs = Date.now();
  const time = location.tz !== UNKNOWN_TZ ? getTimeInTz(location.tz) : null;
  const userAwake = hb?.garryAwake ?? true;
  const wallClockQuietHours = time ? (time.hour >= 23 || time.hour < 8) : false;
  const quietHoursActive = !userAwake && wallClockQuietHours;

  let homeTime: string | null = null;
  if (location.tz !== DEFAULT_TZ && location.tz !== 'US/Pacific' && location.tz !== 'America/Los_Angeles') {
    const ptFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TZ,
      hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short',
    });
    homeTime = `${ptFmt.format(new Date())} PT`;
  }

  const activeFlight = flights?.flights?.find(f => f.status === 'active');
  const activeTravel = activeFlight
    ? `${activeFlight.flightNumber}: ${activeFlight.origin}->${activeFlight.destination}`
    : null;
  const { currentEvent, nextEvents, calendarStale } = resolveActivity(calendarCache, nowMs);

  return {
    now: time?.iso ?? null,
    timezone: location.tz,
    dayOfWeek: time?.dayOfWeek ?? null,
    homeTime,
    location,
    userAwake,
    wallClockQuietHours,
    quietHoursActive,
    activeTravel,
    currentEvent,
    nextEvents,
    todayTasks: resolveTodayTasks(workspaceDir),
    calendarStale,
  };
}

function formatEventShort(evt: CalendarEvent, tz: string): string {
  const name = sanitizeForPrompt(evt.summary ?? 'Untitled');
  let time = '';
  if (evt.start?.includes('T')) {
    try {
      const d = new Date(evt.start);
      time = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
    } catch {
      /* fall through */
    }
  }
  const attendeeStr = evt.attendees?.length
    ? ` (with ${evt.attendees.slice(0, 3).map(a => sanitizeForPrompt(a, 50)).join(', ')}${evt.attendees.length > 3 ? ` +${evt.attendees.length - 3}` : ''})`
    : '';
  return time ? `${time} - ${name}${attendeeStr}` : `${name}${attendeeStr}`;
}

function formatContextBlock(ctx: LiveContext): string {
  const lines: string[] = [
    '## Live Context (deterministic, injected by gbrain prompt hook)',
  ];

  if (ctx.now && ctx.dayOfWeek && ctx.timezone !== UNKNOWN_TZ) {
    lines.push(`- **Time:** ${ctx.now} (${ctx.timezone})`);
    lines.push(`- **Day:** ${ctx.dayOfWeek}`);
  } else {
    lines.push(`- **Timezone:** unknown (${ctx.location.source})`);
    lines.push('- Local time NOT computed - verify timezone before time-sensitive actions');
  }

  lines.push(`- **Location:** ${ctx.location.city} (source: ${ctx.location.source})`);

  if (ctx.homeTime) lines.push(`- **Home (SF):** ${ctx.homeTime}`);
  if (ctx.activeTravel) lines.push(`- **Active travel:** ${ctx.activeTravel}`);
  if (!ctx.userAwake) {
    lines.push(`- **User awake:** no (quiet hours ${ctx.quietHoursActive ? 'active' : 'paused'})`);
  }

  if (ctx.currentEvent) {
    lines.push(`- **Right now:** ${formatEventShort(ctx.currentEvent, ctx.timezone)}`);
  }

  if (ctx.nextEvents.length > 0) {
    lines.push('- **Coming up:**');
    for (const evt of ctx.nextEvents) {
      lines.push(`  - ${formatEventShort(evt, ctx.timezone)}`);
    }
  }

  if (ctx.todayTasks.length > 0) {
    lines.push(`- **Open tasks:** ${ctx.todayTasks.join(' - ')}`);
  }

  if (ctx.calendarStale) {
    lines.push('- Calendar cache >6h old - verify events via ClawVisor if time-sensitive');
  }

  lines.push('');
  lines.push('> This block is computed on every turn. Trust it over compaction summaries for time/location/activity.');

  return lines.join('\n');
}
