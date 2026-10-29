// The calendar family (ARCHITECTURE s.2, s.5): calendars, events, responses and free/busy slots.
// Event titles, descriptions, locations and attendee names are written by other people, so every
// such string is returned wrapped as untrusted. Calendar and event ids are returned prefixed
// (`a1:me@example.com`, `a1:abc123`) and accepted prefixed or bare. Attendees are only e-mailed
// when the caller asks (`notificationLevel`); the default here is none.

import { z } from "zod";
import { loadAccountRefs } from "../core/accounts";
import { mergePages, startFromCursor } from "../core/cursor";
import { ToolError } from "../core/errors";
import { accountKey } from "../core/ids";
import { findNewRecipients, heldBecause, rememberSent } from "../core/recipients";
import { config } from "../env";
import { googleCalendar } from "../providers/google/calendar";
import { defineTool, type Family, type ToolContext } from "../registry/types";
import {
  CALENDAR,
  type CalendarService,
  type EventAttendee,
  type EventInfo,
  type EventInput,
  type EventTime,
  formatInTz,
  isValidTimeZone,
  localIso,
  type ParsedTime,
  parseTimeInput,
  type SendUpdates,
  toInstantMs,
  zonedParts,
  zonedToMs,
} from "../services/calendar";
import { provide } from "../services/capability";
import type { AccountRef } from "../services/types";

const DAY_MS = 86_400_000;
const MAX_DESCRIPTION_CHARS = 8000;
const MAX_FREEBUSY_DAYS = 31;

const account = z
  .string()
  .optional()
  .describe("Label, address or a1; the default account when omitted.");
const accountAll = z
  .string()
  .optional()
  .describe(
    'Label, address or a1; the default account when omitted. "all" merges the primary calendars of every linked account by start time.',
  );

const calendarId = z
  .string()
  .optional()
  .describe("Calendar id (an email address) from list_calendars. Default: the primary calendar.");

const NOTIFICATION = ["NOTIFICATION_LEVEL_UNSPECIFIED", "NONE", "EXTERNAL_ONLY", "ALL"] as const;
const notificationLevel = z
  .enum(NOTIFICATION)
  .optional()
  .describe(
    "Which attendees get an email about this change. Default and UNSPECIFIED: NONE (nobody is emailed unless you ask). EXTERNAL_ONLY: attendees outside the organizer's domain. ALL: every attendee.",
  );

function sendUpdatesOf(level: (typeof NOTIFICATION)[number] | undefined): SendUpdates {
  if (level === "ALL") return "all";
  if (level === "EXTERNAL_ONLY") return "externalOnly";
  return "none";
}

const EVENT_TYPES = [
  "EVENT_TYPE_UNSPECIFIED",
  "DEFAULT",
  "OUT_OF_OFFICE",
  "FOCUS_TIME",
  "WORKING_LOCATION",
  "BIRTHDAY",
  "FROM_GMAIL",
] as const;
const GOOGLE_EVENT_TYPE: Record<string, string> = {
  EVENT_TYPE_UNSPECIFIED: "default",
  DEFAULT: "default",
  OUT_OF_OFFICE: "outOfOffice",
  FOCUS_TIME: "focusTime",
  WORKING_LOCATION: "workingLocation",
  BIRTHDAY: "birthday",
  FROM_GMAIL: "fromGmail",
};
const DEFAULT_EVENT_TYPES = ["default", "outOfOffice", "focusTime", "fromGmail"];

const timeText = (what: string) =>
  z
    .string()
    .min(1)
    .describe(
      `${what} (ISO 8601, for example 2026-04-30T10:00:00). Pass the local time with no UTC offset and no trailing Z; the time zone is timeZone, else the calendar's own.`,
    );

const attendeeInput = z.object({
  email: z.string().min(3).describe("Required. Attendee's email address."),
  displayName: z.string().optional(),
  optionalAttendee: z.boolean().optional(),
  resource: z.boolean().optional(),
  responseStatus: z.string().optional(),
  additionalGuests: z.number().int().min(0).optional(),
});
type AttendeeIn = z.infer<typeof attendeeInput>;

const attachmentInput = z.object({ fileUrl: z.string().min(1), title: z.string().optional() });
const reminderInput = z.object({
  method: z.enum(["email", "popup"]),
  minutes: z.number().int().min(0).max(40320),
});
const guestPermissions = z.object({
  guestsCanInviteOthers: z.boolean().optional(),
  guestsCanModify: z.boolean().optional(),
  guestsCanSeeGuests: z.boolean().optional(),
});
const AVAILABILITY = [
  "AVAILABILITY_UNSPECIFIED",
  "AVAILABILITY_BUSY",
  "AVAILABILITY_FREE",
] as const;
const visibility = z.enum(["default", "public", "private"]).optional();

const hhmm = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// ---- small helpers ------------------------------------------------------------------------

function defined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function parseOrThrow(text: string, field: string): ParsedTime {
  const p = parseTimeInput(text);
  if (!p) {
    throw new ToolError(
      "invalid_argument",
      `${field} is not an ISO 8601 date or time (for example 2026-04-30T10:00:00).`,
    );
  }
  return p;
}

function checkZone(tz: string | undefined): string | undefined {
  if (tz !== undefined && !isValidTimeZone(tz)) {
    throw new ToolError("invalid_argument", "timeZone is not an IANA time zone name.");
  }
  return tz;
}

function lazy<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => {
    p ??= f();
    return p;
  };
}

/** The account and calendar a call addresses, from a calendar id and an event id that may be prefixed. */
async function target(
  ctx: ToolContext,
  selector: string | undefined,
  calId: string | undefined,
  eventId: string | undefined,
): Promise<{ a: AccountRef; cal: string; event: string | undefined }> {
  const dc = calId === undefined ? null : ctx.ids.parse(calId);
  const de = eventId === undefined ? null : ctx.ids.parse(eventId);
  if (dc && de && dc.shortId !== de.shortId) {
    throw new ToolError(
      "invalid_argument",
      "The calendar id and the event id belong to different accounts.",
    );
  }
  const [a] = await ctx.accounts.resolve(selector, (dc ?? de)?.shortId);
  if (!a) throw new ToolError("account_not_found", "No linked account.");
  return {
    a,
    cal: dc?.providerId ?? calId ?? "primary",
    event: de?.providerId ?? eventId,
  };
}

const startMsOf = (e: EventInfo): number => {
  const t = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : undefined);
  const ms = t === undefined ? Number.NaN : Date.parse(t);
  return Number.isNaN(ms) ? 0 : ms;
};

/** Both ends of an existing event as instants, for keeping its length. */
function lengthOf(e: EventInfo): number | null {
  const at = (t?: EventTime): number => {
    const s = t?.dateTime ?? (t?.date ? `${t.date}T00:00:00Z` : undefined);
    return s === undefined ? Number.NaN : Date.parse(s);
  };
  const d = at(e.end) - at(e.start);
  return Number.isNaN(d) || d <= 0 ? null : d;
}

function view(
  ctx: ToolContext,
  a: AccountRef,
  e: EventInfo,
  calId: string,
): Record<string, unknown> {
  const key = accountKey(a.shortId);
  const w = (t: string | undefined, cap?: number): string | undefined =>
    t === undefined
      ? undefined
      : ctx.untrusted.wrap(cap !== undefined && t.length > cap ? t.slice(0, cap) : t, {
          source: "calendar",
          account: key,
        });
  const out: Record<string, unknown> = defined({
    id: ctx.ids.encode(a, e.id),
    calendarId: ctx.ids.encode(a, calId),
    status: e.status,
    summary: w(e.summary),
    description: w(e.description, MAX_DESCRIPTION_CHARS),
    descriptionTruncated:
      e.description !== undefined && e.description.length > MAX_DESCRIPTION_CHARS
        ? true
        : undefined,
    location: w(e.location),
    start: e.start,
    end: e.end,
    htmlLink: e.htmlLink,
    meetUrl: e.meetUrl,
    attendees: e.attendees?.map((x) =>
      defined({
        email: x.email,
        displayName: w(x.displayName),
        responseStatus: x.responseStatus,
        self: x.self,
        organizer: x.organizer,
        optional: x.optional,
        resource: x.resource,
        comment: w(x.comment),
        additionalGuests: x.additionalGuests,
      }),
    ),
    organizer:
      e.organizer === undefined
        ? undefined
        : defined({
            email: e.organizer.email,
            displayName: w(e.organizer.displayName),
            self: e.organizer.self,
          }),
    recurrence: e.recurrence,
    recurringEventId:
      e.recurringEventId === undefined ? undefined : ctx.ids.encode(a, e.recurringEventId),
    eventType: e.eventType,
    visibility: e.visibility,
    availability: e.availability,
    attachments: e.attachments?.map((x) => defined({ fileUrl: x.fileUrl, title: w(x.title) })),
    reminders: e.reminders,
    colorId: e.colorId,
    guestPermissions: e.guestPermissions,
    created: e.created,
    updated: e.updated,
  });
  return out;
}

/** The start of the local day containing `now`, so a default window stays put across pages. */
function startOfToday(now: number, tz: string): number {
  const p = zonedParts(now, tz);
  return zonedToMs({ y: p.y, m: p.m, d: p.d, h: 0, mi: 0, s: 0 }, tz);
}

// ---- reads --------------------------------------------------------------------------------

const listCalendars = defineTool({
  name: "list_calendars",
  title: "List calendars",
  description:
    "Returns the calendars this account owns or has subscribed to, with their ids, access role and time zone. Use it to find a calendarId for the other calendar tools.",
  component: "calendar",
  scopes: ["calendar"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrusted: true,
  input: z.object({
    pageSize: z.number().int().min(1).max(250).optional().describe("Default 100, max 250."),
    pageToken: z.string().optional().describe("nextPageToken of the previous page."),
    account,
  }),
  async handler(args, ctx) {
    const [a] = await ctx.accounts.resolve(args.account);
    if (!a) throw new ToolError("account_not_found", "No linked account.");
    const page = await ctx
      .use(CALENDAR, a)
      .listCalendars(a, { pageSize: args.pageSize ?? 100, pageToken: args.pageToken });
    const key = accountKey(a.shortId);
    const w = (t?: string) =>
      t === undefined ? undefined : ctx.untrusted.wrap(t, { source: "calendar", account: key });
    return {
      calendars: page.items.map((c) =>
        defined({
          id: ctx.ids.encode(a, c.id),
          summary: w(c.summary),
          summaryOverride: c.summaryOverride,
          description: w(c.description),
          primary: c.primary,
          accessRole: c.accessRole,
          timeZone: c.timeZone,
          selected: c.selected,
          hidden: c.hidden,
        }),
      ),
      nextPageToken: page.nextPageToken,
    };
  },
});

interface ListArgs {
  toolName: "list_events" | "search_events";
  account: string | undefined;
  calendarId: string | undefined;
  startTime: string | undefined;
  endTime: string | undefined;
  q: string | undefined;
  eventType: readonly string[] | undefined;
  orderBy: string | undefined;
  pageSize: number | undefined;
  pageToken: string | undefined;
  timeZone: string | undefined;
  /** Default window when startTime and endTime are not given: a week from today, or a year each way. */
  window: "week" | "year";
}

/** list_events and search_events: one account or several, one code path (recipe s.4). */
async function listAcross(ctx: ToolContext, args: ListArgs) {
  const dc = args.calendarId === undefined ? null : ctx.ids.parse(args.calendarId);
  const accounts = await ctx.accounts.resolve(args.account, dc?.shortId, { allowAll: true });
  const many = args.account?.trim().toLowerCase() === "all";
  if (many && args.calendarId !== undefined) {
    throw new ToolError(
      "invalid_argument",
      'account "all" lists the primary calendars; leave calendarId out.',
    );
  }
  const cal = dc?.providerId ?? args.calendarId ?? "primary";
  const explicitTz = checkZone(args.timeZone);
  const startP = args.startTime === undefined ? null : parseOrThrow(args.startTime, "startTime");
  const endP = args.endTime === undefined ? null : parseOrThrow(args.endTime, "endTime");
  if (args.orderBy === "startTimeDesc") {
    throw new ToolError(
      "invalid_argument",
      "orderBy startTimeDesc is not supported; use startTime or lastModified.",
    );
  }
  const orderBy = args.orderBy === "lastModified" ? "updated" : "startTime";
  const types = (args.eventType ?? []).filter((t) => t !== "EVENT_TYPE_UNSPECIFIED");
  const eventTypes =
    types.length === 0
      ? DEFAULT_EVENT_TYPES
      : [...new Set(types.map((t) => GOOGLE_EVENT_TYPE[t] as string))];
  const limit = args.pageSize ?? 100;

  const eligible: { a: AccountRef; svc: CalendarService }[] = [];
  let firstSkip: ToolError | undefined;
  for (const a of accounts) {
    try {
      eligible.push({ a, svc: ctx.use(CALENDAR, a) });
    } catch (e) {
      const skip =
        e instanceof ToolError &&
        (e.code === "component_disabled" || e.code === "not_supported_by_provider");
      if (!skip) throw e;
      firstSkip ??= e;
    }
  }
  if (eligible.length === 0)
    throw firstSkip ?? new ToolError("account_not_found", "No linked account.");
  const keys = eligible.map(({ a }) => accountKey(a.shortId));

  const query = await ctx.cursors.queryHash({
    account: args.account ?? null,
    calendarId: args.calendarId ?? null,
    startTime: args.startTime ?? null,
    endTime: args.endTime ?? null,
    q: args.q ?? null,
    eventType: eventTypes,
    orderBy,
    timeZone: args.timeZone ?? null,
  });
  const cursor = args.pageToken
    ? ctx.cursors.decode(args.pageToken, { tool: args.toolName, query })
    : null;

  const now = ctx.now();
  const pages = await Promise.all(
    startFromCursor(cursor, keys).map(async (s) => {
      const { a, svc } = eligible.find(
        (e) => accountKey(e.a.shortId) === s.key,
      ) as (typeof eligible)[number];
      const tz = lazy(async () => explicitTz ?? (await svc.calendarTimeZone(a, cal)));
      const instant = async (p: ParsedTime): Promise<number> => {
        const own = toInstantMs(p, explicitTz);
        return own ?? (toInstantMs(p, await tz()) as number);
      };
      // Default windows start at the start of today, not "now", so later pages see the same window.
      const today = startOfToday(now, await tz());
      const year = args.window === "year";
      const minMs = startP ? await instant(startP) : year ? today - 365 * DAY_MS : today;
      const maxMs = endP
        ? await instant(endP)
        : year
          ? Math.max(today + 365 * DAY_MS, minMs + DAY_MS)
          : minMs + 7 * DAY_MS;
      if (maxMs <= minMs)
        throw new ToolError("invalid_argument", "endTime must be after startTime.");
      const page = await svc.listEvents(a, cal, {
        timeMin: new Date(minMs).toISOString(),
        timeMax: new Date(maxMs).toISOString(),
        q: args.q,
        eventTypes,
        orderBy,
        pageSize: Math.min(limit + s.skip, 250),
        pageToken: s.tok,
        timeZone: explicitTz,
      });
      return {
        key: s.key,
        tok: s.tok,
        skip: s.skip,
        next: page.nextPageToken,
        items: page.items.map((e) => ({
          k: orderBy === "updated" ? Date.parse(e.updated ?? "") || 0 : startMsOf(e),
          v: view(ctx, a, e, cal),
        })),
      };
    }),
  );
  const merged = mergePages(pages, {
    tool: args.toolName,
    query,
    limit,
    keys,
    compare: (x, y) => x.k - y.k,
  });
  return { events: merged.items.map((i) => i.v), nextPageToken: merged.nextPageToken };
}

const listEvents = defineTool({
  name: "list_events",
  title: "List events",
  description:
    'Returns events on a calendar in a time range, recurring events expanded. Default window: the start of today to seven days later; set startTime and endTime only when a range was asked for. Use fullText for a keyword filter. With account "all" the primary calendars of every account are merged by start time.',
  component: "calendar",
  scopes: ["calendar"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrusted: true,
  input: z.object({
    calendarId,
    startTime: z
      .string()
      .optional()
      .describe("Lower bound (ISO 8601, local time, no offset). Default: the start of today."),
    endTime: z
      .string()
      .optional()
      .describe(
        "Upper bound (ISO 8601, local time, no offset). Default: the lower bound plus 7 days.",
      ),
    fullText: z
      .string()
      .optional()
      .describe(
        "Case-insensitive text matched against title, description, location and attendees.",
      ),
    eventType: z
      .array(z.enum(EVENT_TYPES))
      .optional()
      .describe("Event types to return. Default: DEFAULT, OUT_OF_OFFICE, FOCUS_TIME, FROM_GMAIL."),
    orderBy: z
      .enum(["default", "startTime", "startTimeDesc", "lastModified"])
      .optional()
      .describe(
        "default and startTime: start time ascending. lastModified: last change ascending. startTimeDesc is not supported.",
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(250)
      .optional()
      .describe("Default 100, max 250. 10 is plenty for most questions."),
    pageToken: z.string().optional().describe("nextPageToken of the previous page."),
    timeZone: z
      .string()
      .optional()
      .describe(
        "IANA zone for startTime, endTime and the times in the answer. Default: the calendar's own.",
      ),
    account: accountAll,
  }),
  handler: (args, ctx) =>
    listAcross(ctx, {
      toolName: "list_events",
      account: args.account,
      calendarId: args.calendarId,
      startTime: args.startTime,
      endTime: args.endTime,
      q: args.fullText,
      eventType: args.eventType,
      orderBy: args.orderBy,
      pageSize: args.pageSize,
      pageToken: args.pageToken,
      timeZone: args.timeZone,
      window: "week",
    }),
});

const searchEvents = defineTool({
  name: "search_events",
  title: "Search events",
  description:
    'Searches events on the primary calendar by text (title, description, location, attendees; every word must match). Looks one year back and one year ahead of today unless startTime and endTime are given. With account "all" the primary calendars of every account are merged by start time.',
  component: "calendar",
  scopes: ["calendar"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrusted: true,
  input: z.object({
    query: z.string().min(1).describe("Required. Text to search for (case-insensitive)."),
    startTime: z.string().optional().describe("Lower bound (ISO 8601, local time, no offset)."),
    endTime: z.string().optional().describe("Upper bound (ISO 8601, local time, no offset)."),
    pageSize: z.number().int().min(1).max(250).optional().describe("Default 100, max 250."),
    pageToken: z.string().optional().describe("nextPageToken of the previous page."),
    timeZone: z
      .string()
      .optional()
      .describe("IANA zone for startTime and endTime. Default: the calendar's own."),
    account: accountAll,
  }),
  handler: (args, ctx) =>
    listAcross(ctx, {
      toolName: "search_events",
      account: args.account,
      calendarId: undefined,
      startTime: args.startTime,
      endTime: args.endTime,
      q: args.query,
      eventType: undefined,
      orderBy: undefined,
      pageSize: args.pageSize,
      pageToken: args.pageToken,
      timeZone: args.timeZone,
      window: "year",
    }),
});

const getEvent = defineTool({
  name: "get_event",
  title: "Get an event",
  description: "Returns one event with its attendees, times, location, description and links.",
  component: "calendar",
  scopes: ["calendar"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  untrusted: true,
  input: z.object({
    calendarId,
    eventId: z.string().min(1).describe("Required. Event id from list_events or search_events."),
    account,
  }),
  async handler(args, ctx) {
    const t = await target(ctx, args.account, args.calendarId, args.eventId);
    const e = await ctx.use(CALENDAR, t.a).getEvent(t.a, t.cal, t.event as string);
    return { event: view(ctx, t.a, e, t.cal) };
  },
});

// ---- suggest_time -------------------------------------------------------------------------

const suggestTime = defineTool({
  name: "suggest_time",
  title: "Suggest meeting times",
  description:
    "Finds free slots of durationMinutes in which every listed calendar is free (Google free/busy), inside working hours (default 09:00 to 17:00, set preferences.startHour and endHour). Calendars whose free/busy cannot be read are listed in unavailable and do not block slots.",
  component: "calendar",
  scopes: ["calendar"],
  endpoints: ["full", "ro"],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    attendeeEmails: z
      .array(z.string().min(3))
      .min(1)
      .max(50)
      .describe("Required. Calendars (email addresses) to find common free time for."),
    startTime: timeText("Required. Start of the range to search"),
    endTime: timeText("Required. End of the range to search"),
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(480)
      .optional()
      .describe("Minimum length of a slot. Default 30."),
    preferences: z
      .object({
        startHour: z.string().optional().describe('Earliest slot start as "HH:mm". Default 09:00.'),
        endHour: z.string().optional().describe('Latest slot end as "HH:mm". Default 17:00.'),
        excludeWeekends: z.boolean().optional(),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max slots to return. Default 5."),
      })
      .optional(),
    timeZone: z
      .string()
      .optional()
      .describe(
        "IANA zone for the range, the working hours and the answer. Default: the primary calendar's.",
      ),
    account,
  }),
  async handler(args, ctx) {
    const [a] = await ctx.accounts.resolve(args.account);
    if (!a) throw new ToolError("account_not_found", "No linked account.");
    const svc = ctx.use(CALENDAR, a);
    const prefs = args.preferences ?? {};
    const hour = (
      text: string | undefined,
      dflt: [number, number],
      field: string,
    ): [number, number] => {
      if (text === undefined) return dflt;
      const m = hhmm.exec(text);
      if (!m) throw new ToolError("invalid_argument", `${field} must be "HH:mm" (24-hour).`);
      return [Number(m[1]), Number(m[2])];
    };
    const [sh, sm] = hour(prefs.startHour, [9, 0], "startHour");
    const [eh, em] = hour(prefs.endHour, [17, 0], "endHour");
    if (sh * 60 + sm >= eh * 60 + em) {
      throw new ToolError("invalid_argument", "startHour must be before endHour.");
    }
    const tz = checkZone(args.timeZone) ?? (await svc.calendarTimeZone(a, "primary"));
    const startMs = toInstantMs(parseOrThrow(args.startTime, "startTime"), tz) as number;
    const endMs = toInstantMs(parseOrThrow(args.endTime, "endTime"), tz) as number;
    if (endMs <= startMs)
      throw new ToolError("invalid_argument", "endTime must be after startTime.");
    if (endMs - startMs > MAX_FREEBUSY_DAYS * DAY_MS) {
      throw new ToolError(
        "invalid_argument",
        `The range may be at most ${MAX_FREEBUSY_DAYS} days.`,
      );
    }
    const durMs = (args.durationMinutes ?? 30) * 60_000;
    const wanted = prefs.pageSize ?? 5;
    const emails = [...new Set(args.attendeeEmails.map((e) => e.trim().toLowerCase()))];

    const fb = await svc.freeBusy(a, {
      timeMin: new Date(startMs).toISOString(),
      timeMax: new Date(endMs).toISOString(),
      timeZone: tz,
      calendarIds: emails,
    });
    const unavailable = emails.filter((e) => fb.calendars[e]?.unavailable !== false);
    const busy = emails
      .flatMap((e) => (fb.calendars[e]?.unavailable === false ? (fb.calendars[e]?.busy ?? []) : []))
      .map((b) => [Date.parse(b.start), Date.parse(b.end)] as const)
      .filter(([s, e]) => !Number.isNaN(s) && !Number.isNaN(e))
      .sort((x, y) => x[0] - y[0]);

    const slots: { start: string; end: string }[] = [];
    const from = Math.max(startMs, ctx.now());
    const first = zonedParts(startMs, tz);
    for (let i = 0; i <= MAX_FREEBUSY_DAYS + 1 && slots.length < wanted; i++) {
      // Calendar-day arithmetic in UTC fields, then back to an instant in the zone.
      const day = new Date(Date.UTC(first.y, first.m - 1, first.d + i));
      const dow = day.getUTCDay();
      const y = day.getUTCFullYear();
      const mo = day.getUTCMonth() + 1;
      const d = day.getUTCDate();
      const winStart = Math.max(zonedToMs({ y, m: mo, d, h: sh, mi: sm, s: 0 }, tz), from);
      const winEnd = Math.min(zonedToMs({ y, m: mo, d, h: eh, mi: em, s: 0 }, tz), endMs);
      if (winStart >= endMs) break;
      if (prefs.excludeWeekends === true && (dow === 0 || dow === 6)) continue;
      let at = winStart;
      const gaps: [number, number][] = [];
      for (const [bs, be] of busy) {
        if (be <= at) continue;
        if (bs >= winEnd) break;
        if (bs - at >= durMs) gaps.push([at, bs]);
        at = Math.max(at, be);
      }
      if (winEnd - at >= durMs) gaps.push([at, winEnd]);
      for (const [gs, ge] of gaps) {
        for (let t = gs; t + durMs <= ge && slots.length < wanted; t += durMs) {
          slots.push({ start: formatInTz(t, tz), end: formatInTz(t + durMs, tz) });
        }
      }
    }
    return { timeZone: tz, slots, unavailable };
  },
});

// ---- writes -------------------------------------------------------------------------------

/** An event time from the official text fields, resolving the zone only when the text has no offset. */
async function eventTimeOf(
  p: ParsedTime,
  allDay: boolean,
  explicitTz: string | undefined,
  tz: () => Promise<string>,
): Promise<EventTime> {
  if (allDay) return { date: localIso(p).slice(0, 10) };
  if (p.offsetMinutes !== undefined) {
    const off = p.offsetMinutes;
    const sign = off < 0 ? "-" : "+";
    const abs = Math.abs(off);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return defined({ dateTime: `${localIso(p)}${sign}${hh}:${mm}`, timeZone: explicitTz });
  }
  return { dateTime: localIso(p), timeZone: explicitTz ?? (await tz()) };
}

/** The day after a `YYYY-MM-DD` date. */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

function attendeesOf(
  list: readonly AttendeeIn[] | undefined,
  emails: readonly string[] | undefined,
): EventAttendee[] {
  const out: EventAttendee[] = [];
  const seen = new Set<string>();
  const add = (x: EventAttendee) => {
    const k = x.email.trim().toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(x);
  };
  for (const x of list ?? []) {
    add(
      defined({
        email: x.email.trim(),
        displayName: x.displayName,
        optional: x.optionalAttendee,
        resource: x.resource,
        responseStatus: x.responseStatus,
        additionalGuests: x.additionalGuests,
      }),
    );
  }
  for (const e of emails ?? []) add({ email: e.trim() });
  return out;
}

function remindersOf(
  overrides: readonly { method: string; minutes: number }[] | undefined,
  useDefault: boolean | undefined,
): EventInput["reminders"] {
  if (overrides && overrides.length > 0) {
    if (useDefault === true) {
      throw new ToolError(
        "invalid_argument",
        "useDefaultReminders cannot be true together with overrideReminders.",
      );
    }
    return { useDefault: false, overrides: overrides.map((r) => ({ ...r })) };
  }
  if (useDefault === undefined) return undefined;
  return { useDefault };
}

function refuseMeetUrl(url: string | undefined): void {
  if (url !== undefined) {
    throw new ToolError(
      "invalid_argument",
      "googleMeetUrl is not supported; use addGoogleMeetUrl to create a new Meet link.",
    );
  }
}

// ---- Notifications are sends ------------------------------------------------------------------
// A calendar change can make Google email people with text the caller chose (title, description,
// a response comment), so it is a send: it obeys SEND_ENABLED and the owner switch, counts against
// the account's send limits and recipient cap, writes an audit row (addresses, never the event
// text) and, by default (`SEND_APPROVAL_MODE`) is held for the owner when a recipient is new. A change that notifies nobody
// outside the owner's own accounts is not a send and is unchanged. With no `notificationLevel`
// the level is none, which is also Google's own default for `sendUpdates`, so nobody is mailed.

const ROOM_DOMAIN = "@resource.calendar.google.com";

type CalendarSendTool = "create_event" | "update_event" | "delete_event" | "respond_to_event";

/** What the four writing tools share, as far as notifications go. */
interface NotifyArgs {
  calendarId?: string | undefined;
  eventId?: string | undefined;
  account?: string | undefined;
  notificationLevel?: (typeof NOTIFICATION)[number] | undefined;
  attendees?: readonly AttendeeIn[] | undefined;
  attendeeEmails?: readonly string[] | undefined;
  addedAttendees?: readonly AttendeeIn[] | undefined;
  addedAttendeeEmails?: readonly string[] | undefined;
  responseComment?: string | undefined;
  /** The notified recipients `approval.when` checked (the server's field, never the caller's). */
  checkedRecipients?: string[] | undefined;
}

/** The input field that carries `checkedRecipients` on the three tools that read the event. */
const checkedRecipientsParam = z
  .array(z.string())
  .optional()
  .describe("Set by the server; any value given here is replaced.");

interface SendPlan {
  a: AccountRef;
  cal: string;
  event: string | undefined;
  sendUpdates: SendUpdates;
  /** Distinct lowercase addresses outside the owner's own accounts that Google will email. */
  recipients: string[];
  /** The etag of the event the plan was made from, when it read one. */
  etag?: string | undefined;
}

/**
 * The one place that decides whom a calendar call emails: the addresses outside the owner's own
 * linked accounts. The caller's `notificationLevel` decides whether Google mails anyone. With it
 * on, create mails the attendees it names; update mails the event's current guests (removed ones
 * too) and the ones it adds; delete mails the current guests; respond mails the organizer only. A
 * respond with a comment counts as a send even with notifications off, because the comment is text
 * for the organizer. `externalOnly` is treated like `all`: Google skips guests it can reach inside
 * Calendar, which is not known here. Rooms (Google's resource addresses, or guests Google itself marks as resources) are never mailed; the caller's own `resource` flag is ignored. `known` is the
 * event when the caller has already read it. A "hold sends to new recipients" rule belongs on the
 * list this returns (see `holdsSend`).
 */
async function notifiedRecipients(
  ctx: ToolContext,
  t: { a: AccountRef; cal: string; event: string | undefined },
  tool: CalendarSendTool,
  args: NotifyArgs,
  known?: EventInfo,
): Promise<{ recipients: string[]; etag?: string | undefined }> {
  const level = sendUpdatesOf(args.notificationLevel);
  const comment = tool === "respond_to_event" && (args.responseComment ?? "").trim() !== "";
  if (level === "none" && !comment) return { recipients: [] };
  // The caller's own `resource` flag is never trusted (it would let a prompt-injected caller take
  // an outside address out of the count); only what Google returned, and room addresses, are skipped.
  const candidates: EventAttendee[] = [];
  let etag: string | undefined;
  const named = (list: readonly AttendeeIn[] | undefined, emails: readonly string[] | undefined) =>
    attendeesOf(list, emails).map((x) => ({ ...x, resource: false }));
  if (tool === "create_event") candidates.push(...named(args.attendees, args.attendeeEmails));
  if (tool === "update_event")
    candidates.push(...named(args.addedAttendees, args.addedAttendeeEmails));
  if (tool !== "create_event") {
    let event = known;
    if (!event) {
      try {
        event = await ctx.use(CALENDAR, t.a).getEvent(t.a, t.cal, t.event as string);
      } catch (e) {
        // Deleting an event that is already gone (404, or 410 Gone) mails nobody; the delete then
        // answers as before.
        const gone =
          e instanceof ToolError && (e.code === "not_found" || e.details?.status === 410);
        if (!(tool === "delete_event" && gone)) throw e;
      }
    }
    etag = event?.etag;
    if (tool === "respond_to_event") {
      // An account that is not a guest has no response to set: the provider refuses it, so nothing
      // is mailed and no send is spent on it.
      if (event && !(event.attendees ?? []).some((x) => x.self === true)) return { recipients: [] };
      if (event?.organizer?.email) candidates.push({ email: event.organizer.email });
    } else {
      // The organizer is mailed too, and an outsider may be missing from the guest list Google shows.
      if (event?.organizer?.email) candidates.push({ email: event.organizer.email });
      candidates.push(...(event?.attendees ?? []));
    }
  }
  const own = new Set(
    (await loadAccountRefs(ctx.env.DB, ctx.ownerId)).map((x) => x.address.toLowerCase()),
  );
  const out = new Set<string>();
  for (const c of candidates) {
    const email = c.email.trim().toLowerCase();
    if (c.resource === true || email.endsWith(ROOM_DOMAIN) || !email.includes("@")) continue;
    if (own.has(email)) continue;
    out.add(email);
  }
  return { recipients: [...out], etag };
}

/** Writes an audit row for a calendar send; a failing log never changes the answer. */
async function auditSend(
  ctx: ToolContext,
  tool: CalendarSendTool,
  a: AccountRef,
  recipients: readonly string[],
  result: "ok" | "refused" | "error" | "pending",
  detail: string,
  providerRef?: string,
): Promise<void> {
  try {
    await ctx.audit.write({
      tool,
      account: a,
      to: recipients,
      subject: "",
      providerRef: providerRef ?? null,
      result,
      detail,
    });
  } catch {
    console.error(`${tool}: the audit row could not be written`);
  }
}

const errorCode = (e: unknown): string => (e instanceof ToolError ? e.code : "internal");

/**
 * Runs `run`, the provider call. When the call notifies someone it first passes `checkSend`
 * (sending on, the recipient cap, the rate limits), and it is audited whatever happens; a refused
 * call never reaches the provider. With no outside recipient it just runs.
 */
async function guardedNotify<T>(
  ctx: ToolContext,
  tool: CalendarSendTool,
  plan: SendPlan,
  run: () => Promise<T>,
  refOf: (r: T) => string | undefined,
): Promise<T> {
  const { a, recipients } = plan;
  if (recipients.length === 0) return run();
  const detail = `notify=${plan.sendUpdates}`;
  try {
    await ctx.limits.checkSend(a, recipients);
  } catch (e) {
    await auditSend(ctx, tool, a, recipients, "refused", `${errorCode(e)}; ${detail}`);
    throw e;
  }
  try {
    const r = await run();
    await auditSend(ctx, tool, a, recipients, "ok", detail, refOf(r));
    await rememberSent(ctx, a, recipients);
    return r;
  } catch (e) {
    await auditSend(ctx, tool, a, recipients, "error", `${errorCode(e)}; ${detail}`);
    throw e;
  }
}

/** The plan of a call, from its arguments and the event as it is now. */
async function planOf(
  ctx: ToolContext,
  tool: CalendarSendTool,
  args: NotifyArgs,
  known?: { t?: Awaited<ReturnType<typeof target>>; event?: EventInfo },
): Promise<SendPlan> {
  const t = known?.t ?? (await target(ctx, args.account, args.calendarId, args.eventId));
  const { recipients, etag } = await notifiedRecipients(ctx, t, tool, args, known?.event);
  return { ...t, sendUpdates: sendUpdatesOf(args.notificationLevel), recipients, etag };
}

/**
 * The `If-Match` of a write that notifies people: the etag of the event the plan was made from, so
 * Google refuses the write (HTTP 412) if the event, and with it the guest list, changed since. With
 * notifications off nobody is mailed and no precondition is set.
 */
function ifMatchOf(plan: SendPlan): string | undefined {
  if (plan.sendUpdates === "none") return undefined;
  // An event that is already gone (nothing to read) mails nobody. Otherwise no etag would mean
  // no precondition on a write that notifies people: refused rather than sent unprotected.
  if (plan.etag === undefined && plan.recipients.length > 0) {
    throw new ToolError(
      "upstream_error",
      "Google did not say which version of the event was read, so the change cannot be made safely. Nothing was sent or changed.",
    );
  }
  return plan.etag;
}

/**
 * Refuses a call whose fresh plan notifies someone the plan that was checked (and, when held,
 * shown to the owner) did not name. The handler of `update_event`, `delete_event` and
 * `respond_to_event` works the list out from the event's guests as they are when it runs, so a
 * guest added after the check would otherwise be mailed unchecked. Nothing has been sent or
 * changed when this throws; it is audited like any other refusal. No `checkedRecipients` (sending
 * approval is off) means nothing to compare.
 */
async function assertChecked(
  ctx: ToolContext,
  tool: CalendarSendTool,
  args: NotifyArgs,
  plan: SendPlan,
): Promise<void> {
  const checked = args.checkedRecipients;
  if (!checked || plan.recipients.every((r) => checked.includes(r))) return;
  await auditSend(ctx, tool, plan.a, plan.recipients, "refused", "recipients_changed");
  throw new ToolError(
    "invalid_argument",
    "The people this change would email are not the ones that were checked: the event's guests changed in between. Nothing was sent or changed; ask for the change again.",
  );
}

const heldPlans = new WeakMap<object, Promise<SendPlan>>();

/** The plan of a call being held or previewed, worked out once for `when`, `preview` and `onHeld`. */
function heldPlan(ctx: ToolContext, tool: CalendarSendTool, args: NotifyArgs): Promise<SendPlan> {
  let p = heldPlans.get(args);
  if (!p) {
    p = planOf(ctx, tool, args);
    heldPlans.set(args, p);
  }
  return p;
}

/** The recipients a hold found new, by the call's arguments: `when` writes, `preview` reads. */
const newOnes = new WeakMap<object, string[]>();

/**
 * Whether a calendar send is held for the owner, as for mail sends: in mode `all` always, in mode
 * `new_recipients` (the default) when at least one outside recipient is new to the account, in
 * mode `off` never. It gets the whole plan.
 */
async function holdsSend(ctx: ToolContext, plan: SendPlan, args: object): Promise<boolean> {
  const mode = config(ctx.env).sendApprovalMode;
  if (mode === "off") return false;
  if (mode === "all") return true;
  const found = await findNewRecipients(ctx, plan.a, plan.recipients);
  if (found.length === 0) return false;
  newOnes.set(args, found);
  return true;
}

/**
 * `approval` of the four writing tools. Like a mail send it holds only a call that is a send, and
 * refuses at once (audited, nothing queued) one that could never go out: sending off, or over the
 * recipient cap. The approved run repeats every check in the handler.
 */
function sendApproval(tool: CalendarSendTool) {
  return {
    async when(args: NotifyArgs, ctx: ToolContext): Promise<boolean> {
      // The server's field, never the caller's: cleared first, whatever the mode.
      args.checkedRecipients = undefined;
      // Cheap exit: no event read for a call that cannot be held.
      if (config(ctx.env).sendApprovalMode === "off") return false;
      const plan = await heldPlan(ctx, tool, args);
      // The notified recipients as checked here, held or not: stored with the call, so the handler
      // (now, or once approved) refuses when the event's guests would notify someone else.
      // `create_event` names its guests in the call itself and needs no such record.
      if (tool !== "create_event") args.checkedRecipients = plan.recipients;
      if (plan.recipients.length === 0 || !(await holdsSend(ctx, plan, args))) return false;
      try {
        await ctx.limits.assertSendEnabled(plan.a);
        const max = config(ctx.env).maxRecipients;
        if (plan.recipients.length > max) {
          throw new ToolError(
            "too_many_recipients",
            `A message may have at most ${max} recipients across to, cc and bcc; this one has ${plan.recipients.length}.`,
            { maxRecipients: max },
          );
        }
      } catch (e) {
        await auditSend(ctx, tool, plan.a, plan.recipients, "refused", errorCode(e));
        throw e;
      }
      return true;
    },
    async preview(args: NotifyArgs, ctx: ToolContext): Promise<unknown> {
      const plan = await heldPlan(ctx, tool, args);
      return {
        action: "Calendar change that makes Google email people",
        tool,
        account: plan.a.label,
        calendarId: ctx.ids.encode(plan.a, plan.cal),
        ...(plan.event === undefined ? {} : { eventId: ctx.ids.encode(plan.a, plan.event) }),
        notify: plan.sendUpdates,
        to: plan.recipients,
        ...(newOnes.get(args)
          ? {
              newRecipients: newOnes.get(args),
              heldBecause: heldBecause(newOnes.get(args) ?? []),
            }
          : {}),
        ...(args.responseComment ? { withComment: true } : {}),
      };
    },
    // After the pending action exists, so a failed hold leaves no row, and with its id.
    async onHeld(
      args: NotifyArgs,
      ctx: ToolContext,
      held: { pendingActionId: string },
    ): Promise<void> {
      const plan = await heldPlan(ctx, tool, args);
      await auditSend(
        ctx,
        tool,
        plan.a,
        plan.recipients,
        "pending",
        `pending action ${held.pendingActionId}: approval requested, notify=${plan.sendUpdates}`,
        plan.event,
      );
    },
  };
}

const createEvent = defineTool({
  name: "create_event",
  title: "Create an event",
  description:
    "Creates an event. Attendees are not emailed unless notificationLevel is EXTERNAL_ONLY or ALL (default NONE). Emailing anyone outside your linked accounts counts as a send: it needs sending switched on, counts against the send limits and is audited (and held for approval when the server requires it). Pass startTime and endTime as local times with no offset; give timeZone only when the user named one.",
  component: "calendar",
  scopes: ["calendar"],
  endpoints: ["full"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  untrusted: true,
  input: z.object({
    summary: z.string().min(1).describe("Required. Title."),
    startTime: timeText("Required. Start time"),
    endTime: timeText("Required. End time"),
    calendarId,
    allDay: z
      .boolean()
      .optional()
      .describe(
        "The event spans whole days; the dates of startTime and endTime are used (the end date is exclusive).",
      ),
    timeZone: z.string().optional().describe("IANA zone, only when the user named one."),
    description: z.string().optional(),
    location: z.string().optional(),
    attendees: z.array(attendeeInput).optional(),
    attendeeEmails: z.array(z.string()).optional().describe("Deprecated: use attendees."),
    addGoogleMeetUrl: z.boolean().optional().describe("Create and add a Google Meet link."),
    googleMeetUrl: z.string().optional().describe("Not supported: use addGoogleMeetUrl."),
    attachments: z.array(attachmentInput).optional(),
    availability: z.enum(AVAILABILITY).optional(),
    colorId: z.string().optional(),
    eventType: z.enum(EVENT_TYPES).optional(),
    guestPermissions: guestPermissions.optional(),
    overrideReminders: z.array(reminderInput).optional(),
    useDefaultReminders: z.boolean().optional(),
    recurrenceData: z
      .array(z.string())
      .optional()
      .describe("RRULE, RDATE or EXDATE lines (RFC 5545)."),
    visibility,
    workingLocationProperties: z
      .object({
        type: z
          .enum([
            "WORKING_LOCATION_TYPE_UNSPECIFIED",
            "HOME_OFFICE",
            "CUSTOM_LOCATION",
            "OFFICE_LOCATION",
          ])
          .optional(),
        customLocationLabel: z.string().optional(),
        officeLocation: z
          .object({
            buildingId: z.string().optional(),
            deskId: z.string().optional(),
            floorId: z.string().optional(),
            floorSectionId: z.string().optional(),
            label: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    notificationLevel,
    account,
  }),
  approval: sendApproval("create_event"),
  async handler(args, ctx) {
    refuseMeetUrl(args.googleMeetUrl);
    if (args.eventType === "FROM_GMAIL") {
      throw new ToolError("invalid_argument", "Events of type FROM_GMAIL cannot be created.");
    }
    const t = await target(ctx, args.account, args.calendarId, undefined);
    const svc = ctx.use(CALENDAR, t.a);
    const explicitTz = checkZone(args.timeZone);
    const tz = lazy(() => svc.calendarTimeZone(t.a, t.cal));
    const sp = parseOrThrow(args.startTime, "startTime");
    const ep = parseOrThrow(args.endTime, "endTime");
    const allDay = args.allDay === true;
    const start = await eventTimeOf(sp, allDay, explicitTz, tz);
    let end = await eventTimeOf(ep, allDay, explicitTz, tz);
    if (allDay) {
      if ((end.date as string) <= (start.date as string))
        end = { date: nextDay(start.date as string) };
    } else {
      const zone =
        explicitTz ??
        (sp.offsetMinutes === undefined || ep.offsetMinutes === undefined ? await tz() : undefined);
      const s = toInstantMs(sp, zone);
      const e = toInstantMs(ep, zone);
      if (s !== null && e !== null && e <= s) {
        throw new ToolError("invalid_argument", "endTime must be after startTime.");
      }
    }
    const input: EventInput = defined({
      summary: args.summary,
      description: args.description,
      location: args.location,
      start,
      end,
      attendees: attendeesOf(args.attendees, args.attendeeEmails),
      recurrence: args.recurrenceData,
      addMeet: args.addGoogleMeetUrl === true ? true : undefined,
      attachments: args.attachments,
      reminders: remindersOf(args.overrideReminders, args.useDefaultReminders),
      colorId: args.colorId,
      visibility: args.visibility,
      availability:
        args.availability === "AVAILABILITY_FREE"
          ? ("FREE" as const)
          : args.availability === "AVAILABILITY_BUSY"
            ? ("BUSY" as const)
            : undefined,
      eventType: args.eventType === "EVENT_TYPE_UNSPECIFIED" ? undefined : args.eventType,
      guestPermissions: args.guestPermissions,
      workingLocation:
        args.workingLocationProperties === undefined
          ? undefined
          : defined({
              type:
                args.workingLocationProperties.type === "WORKING_LOCATION_TYPE_UNSPECIFIED"
                  ? undefined
                  : args.workingLocationProperties.type,
              customLocationLabel: args.workingLocationProperties.customLocationLabel,
              officeLocation: args.workingLocationProperties.officeLocation,
            }),
    });
    if (input.attendees?.length === 0) delete input.attendees;
    const plan = await planOf(ctx, "create_event", args, { t });
    const { sendUpdates } = plan;
    const e = await guardedNotify(
      ctx,
      "create_event",
      plan,
      () => svc.createEvent(t.a, t.cal, input, sendUpdates),
      (r) => r.id,
    );
    return { event: view(ctx, t.a, e, t.cal), notified: sendUpdates };
  },
});

const updateEvent = defineTool({
  name: "update_event",
  title: "Update an event",
  description:
    "Changes an event; fields left out stay as they are. Changing only startTime keeps the event's length. Attendees are not emailed unless notificationLevel is EXTERNAL_ONLY or ALL (default NONE). Emailing anyone outside your linked accounts counts as a send: it needs sending switched on, counts against the send limits and is audited (and held for approval when the server requires it).",
  component: "calendar",
  scopes: ["calendar"],
  endpoints: ["full"],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  untrusted: true,
  input: z.object({
    eventId: z.string().min(1).describe("Required. Event id from list_events or search_events."),
    calendarId,
    summary: z.string().optional(),
    startTime: z.string().optional().describe("New start (ISO 8601, local time, no offset)."),
    endTime: z.string().optional().describe("New end (ISO 8601, local time, no offset)."),
    allDay: z
      .boolean()
      .optional()
      .describe("Make the event all-day; startTime and endTime are then required."),
    timeZone: z.string().optional().describe("IANA zone, only when the user named one."),
    description: z.string().optional(),
    location: z.string().optional(),
    addedAttendees: z.array(attendeeInput).optional(),
    addedAttendeeEmails: z.array(z.string()).optional().describe("Deprecated: use addedAttendees."),
    removedAttendeeEmails: z.array(z.string()).optional(),
    addGoogleMeetUrl: z.boolean().optional(),
    googleMeetUrl: z.string().optional().describe("Not supported: use addGoogleMeetUrl."),
    addedAttachments: z.array(attachmentInput).optional(),
    removedAttachmentFileUrls: z.array(z.string()).optional(),
    availability: z.enum(AVAILABILITY).optional(),
    colorId: z.string().optional(),
    guestPermissions: guestPermissions.optional(),
    overrideReminders: z.array(reminderInput).optional(),
    useDefaultReminders: z.boolean().optional(),
    visibility,
    notificationLevel,
    checkedRecipients: checkedRecipientsParam,
    account,
  }),
  approval: sendApproval("update_event"),
  async handler(args, ctx) {
    refuseMeetUrl(args.googleMeetUrl);
    const t = await target(ctx, args.account, args.calendarId, args.eventId);
    const svc = ctx.use(CALENDAR, t.a);
    const eventId = t.event as string;
    const explicitTz = checkZone(args.timeZone);
    const addAtt = attendeesOf(args.addedAttendees, args.addedAttendeeEmails);
    const removed = new Set((args.removedAttendeeEmails ?? []).map((e) => e.trim().toLowerCase()));
    const addAttach = args.addedAttachments ?? [];
    const removedUrls = new Set(args.removedAttachmentFileUrls ?? []);
    const allDay = args.allDay === true;
    if (allDay && (args.startTime === undefined || args.endTime === undefined)) {
      throw new ToolError("invalid_argument", "allDay needs both startTime and endTime.");
    }
    const needsCurrent =
      addAtt.length > 0 ||
      removed.size > 0 ||
      addAttach.length > 0 ||
      removedUrls.size > 0 ||
      (args.startTime !== undefined) !== (args.endTime !== undefined);
    const current = needsCurrent ? await svc.getEvent(t.a, t.cal, eventId) : undefined;
    const tz = lazy(
      async () => current?.start?.timeZone ?? (await svc.calendarTimeZone(t.a, t.cal)),
    );

    const patch: EventInput = defined({
      summary: args.summary,
      description: args.description,
      location: args.location,
      addMeet: args.addGoogleMeetUrl === true ? true : undefined,
      reminders: remindersOf(args.overrideReminders, args.useDefaultReminders),
      colorId: args.colorId,
      visibility: args.visibility,
      availability:
        args.availability === "AVAILABILITY_FREE"
          ? ("FREE" as const)
          : args.availability === "AVAILABILITY_BUSY"
            ? ("BUSY" as const)
            : undefined,
      guestPermissions: args.guestPermissions,
    });

    if (args.startTime !== undefined || args.endTime !== undefined) {
      const sp = args.startTime === undefined ? null : parseOrThrow(args.startTime, "startTime");
      const ep = args.endTime === undefined ? null : parseOrThrow(args.endTime, "endTime");
      if (allDay) {
        const s = await eventTimeOf(sp as ParsedTime, true, explicitTz, tz);
        let e = await eventTimeOf(ep as ParsedTime, true, explicitTz, tz);
        if ((e.date as string) <= (s.date as string)) e = { date: nextDay(s.date as string) };
        patch.start = s;
        patch.end = e;
      } else if (current?.start?.date !== undefined && !(sp && ep)) {
        // One side of an all-day event moves: stay all-day and keep the other side.
        if ((sp && !sp.dateOnly) || (ep && !ep.dateOnly)) {
          throw new ToolError(
            "invalid_argument",
            "This is an all-day event: give both startTime and endTime to make it a timed event.",
          );
        }
        const curStart = current.start.date;
        const curEnd = current.end?.date ?? nextDay(curStart);
        const days = Math.max(1, Math.round((Date.parse(curEnd) - Date.parse(curStart)) / DAY_MS));
        const newStart = sp ? localIso(sp).slice(0, 10) : curStart;
        const newEnd = ep
          ? localIso(ep).slice(0, 10)
          : new Date(Date.parse(newStart) + days * DAY_MS).toISOString().slice(0, 10);
        if (newEnd <= newStart) {
          throw new ToolError("invalid_argument", "endTime must be after startTime.");
        }
        patch.start = { date: newStart };
        patch.end = { date: newEnd };
      } else {
        const zone = explicitTz ?? (await tz());
        if (sp) patch.start = await eventTimeOf(sp, false, explicitTz, tz);
        if (ep) patch.end = await eventTimeOf(ep, false, explicitTz, tz);
        if (sp && !ep) {
          // Only the start moves: keep the event's length.
          const len = current ? lengthOf(current) : null;
          const s = toInstantMs(sp, zone) as number;
          if (len !== null) patch.end = { dateTime: formatInTz(s + len, zone), timeZone: zone };
        }
        const sMs = sp ? (toInstantMs(sp, zone) as number) : undefined;
        const eMs = ep ? (toInstantMs(ep, zone) as number) : undefined;
        if (sMs !== undefined && eMs !== undefined && eMs <= sMs) {
          throw new ToolError("invalid_argument", "endTime must be after startTime.");
        }
        if (ep && !sp && current?.start) {
          const cs = Date.parse(current.start.dateTime ?? "");
          if (!Number.isNaN(cs) && (eMs as number) <= cs) {
            throw new ToolError("invalid_argument", "endTime must be after the event's start.");
          }
        }
      }
    }

    if (addAtt.length > 0 || removed.size > 0) {
      const byEmail = new Map<string, EventAttendee>();
      for (const x of current?.attendees ?? []) byEmail.set(x.email.toLowerCase(), x);
      for (const x of addAtt)
        byEmail.set(x.email.toLowerCase(), { ...byEmail.get(x.email.toLowerCase()), ...x });
      for (const e of removed) byEmail.delete(e);
      patch.attendees = [...byEmail.values()];
    }
    if (addAttach.length > 0 || removedUrls.size > 0) {
      const kept = (current?.attachments ?? []).filter((x) => !removedUrls.has(x.fileUrl));
      const have = new Set(kept.map((x) => x.fileUrl));
      patch.attachments = [...kept, ...addAttach.filter((x) => !have.has(x.fileUrl))];
    }
    if (Object.keys(patch).length === 0) {
      throw new ToolError(
        "invalid_argument",
        "Nothing to change: give at least one field to update.",
      );
    }
    const plan = await planOf(ctx, "update_event", args, {
      t,
      ...(current ? { event: current } : {}),
    });
    await assertChecked(ctx, "update_event", args, plan);
    const { sendUpdates } = plan;
    const e = await guardedNotify(
      ctx,
      "update_event",
      plan,
      () => svc.updateEvent(t.a, t.cal, eventId, patch, sendUpdates, ifMatchOf(plan)),
      (r) => r.id,
    );
    return { event: view(ctx, t.a, e, t.cal), notified: sendUpdates };
  },
});

const deleteEvent = defineTool({
  name: "delete_event",
  title: "Delete an event",
  description:
    "Deletes an event. Attendees are not emailed about the cancellation unless notificationLevel is EXTERNAL_ONLY or ALL (default NONE). Emailing anyone outside your linked accounts counts as a send: it needs sending switched on, counts against the send limits and is audited (and held for approval when the server requires it).",
  component: "calendar",
  scopes: ["calendar"],
  endpoints: ["full"],
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    eventId: z.string().min(1).describe("Required. The id of the event to delete."),
    calendarId,
    notificationLevel,
    checkedRecipients: checkedRecipientsParam,
    account,
  }),
  approval: sendApproval("delete_event"),
  async handler(args, ctx) {
    const t = await target(ctx, args.account, args.calendarId, args.eventId);
    const plan = await planOf(ctx, "delete_event", args, { t });
    await assertChecked(ctx, "delete_event", args, plan);
    const { sendUpdates } = plan;
    await guardedNotify(
      ctx,
      "delete_event",
      plan,
      () =>
        ctx
          .use(CALENDAR, t.a)
          .deleteEvent(t.a, t.cal, t.event as string, sendUpdates, ifMatchOf(plan)),
      () => t.event,
    );
    return { deleted: ctx.ids.encode(t.a, t.event as string), notified: sendUpdates };
  },
});

const respondToEvent = defineTool({
  name: "respond_to_event",
  title: "Respond to an event",
  description:
    "Sets this account's own response to an event invitation. Only the account's own attendee entry changes. The organizer is not emailed unless notificationLevel is EXTERNAL_ONLY or ALL (default NONE). A responseComment, or notifications on, counts as a send to the organizer: it needs sending switched on, counts against the send limits and is audited (and held for approval when the server requires it).",
  component: "calendar",
  scopes: ["calendar"],
  endpoints: ["full"],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  untrusted: true,
  input: z.object({
    eventId: z.string().min(1).describe("Required. The id of the event to respond to."),
    responseStatus: z
      .enum(["accepted", "declined", "tentative"])
      .describe("Required. accepted, declined or tentative."),
    responseComment: z.string().optional().describe("A comment sent with the response."),
    calendarId,
    notificationLevel,
    checkedRecipients: checkedRecipientsParam,
    account,
  }),
  approval: sendApproval("respond_to_event"),
  async handler(args, ctx) {
    const t = await target(ctx, args.account, args.calendarId, args.eventId);
    const plan = await planOf(ctx, "respond_to_event", args, { t });
    // Residual window: the organizer, the one person a response mails, is read here, and the
    // provider then reads the guest list and patches (two more Google calls). The organizer cannot
    // change in between except by moving the event to another calendar, and no other guest is
    // mailed by a response. There is no `If-Match` here: the etag moves whenever any guest
    // answers, which would fail most responses to a large event.
    await assertChecked(ctx, "respond_to_event", args, plan);
    const { sendUpdates } = plan;
    const e = await guardedNotify(
      ctx,
      "respond_to_event",
      plan,
      () =>
        ctx
          .use(CALENDAR, t.a)
          .respond(
            t.a,
            t.cal,
            t.event as string,
            defined({ status: args.responseStatus, comment: args.responseComment }),
            sendUpdates,
          ),
      (r) => r.id,
    );
    return { event: view(ctx, t.a, e, t.cal), notified: sendUpdates };
  },
});

export const calendar: Family = {
  id: "calendar",
  tools: [
    listCalendars,
    listEvents,
    searchEvents,
    getEvent,
    suggestTime,
    createEvent,
    updateEvent,
    deleteEvent,
    respondToEvent,
  ] as unknown as Family["tools"],
  bindings: { google: [provide(CALENDAR, googleCalendar)] },
  parityPending: [],
};
