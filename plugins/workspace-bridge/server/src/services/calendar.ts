// The calendar capability (ARCHITECTURE s.3.6): calendars, events, responses and free/busy. The
// interface returns plain data and knows nothing about MCP or Google. The time helpers at the
// end are pure, so the tools can turn the official "local time, no offset" strings into instants.

import { capability } from "./capability";
import type { AccountRef, Page } from "./types";

/** A start or end: a `dateTime` (with an offset, or local to `timeZone`) or an all-day `date`. */
export interface EventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarInfo {
  id: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  selected?: boolean;
  hidden?: boolean;
  backgroundColor?: string;
}

export interface EventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
  resource?: boolean;
  comment?: string;
  additionalGuests?: number;
}

export interface EventAttachment {
  fileUrl: string;
  title?: string;
}

export interface EventReminders {
  useDefault: boolean;
  overrides?: { method: string; minutes: number }[];
}

export interface GuestPermissions {
  guestsCanInviteOthers?: boolean;
  guestsCanModify?: boolean;
  guestsCanSeeGuests?: boolean;
}

export interface EventInfo {
  id: string;
  /** Google's etag of this version of the event, for a conditional write (`ifMatch`). */
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  htmlLink?: string;
  meetUrl?: string;
  attendees?: EventAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  recurrence?: string[];
  recurringEventId?: string;
  eventType?: string;
  visibility?: string;
  /** `BUSY` or `FREE`. */
  availability?: string;
  attachments?: EventAttachment[];
  reminders?: EventReminders;
  colorId?: string;
  guestPermissions?: GuestPermissions;
  created?: string;
  updated?: string;
}

export type SendUpdates = "none" | "externalOnly" | "all";

export interface WorkingLocation {
  type?: "HOME_OFFICE" | "CUSTOM_LOCATION" | "OFFICE_LOCATION";
  customLocationLabel?: string;
  officeLocation?: {
    buildingId?: string;
    deskId?: string;
    floorId?: string;
    floorSectionId?: string;
    label?: string;
  };
}

/** The writable parts of an event. On an update, a key that is present replaces that part. */
export interface EventInput {
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  /** The whole attendee list. */
  attendees?: EventAttendee[];
  recurrence?: string[];
  /** Add a Google Meet link. */
  addMeet?: boolean;
  /** The whole attachment list. */
  attachments?: EventAttachment[];
  reminders?: EventReminders;
  colorId?: string;
  visibility?: string;
  availability?: "BUSY" | "FREE";
  eventType?: string;
  guestPermissions?: GuestPermissions;
  workingLocation?: WorkingLocation;
}

export interface ListEventsQuery {
  /** RFC 3339 instants. */
  timeMin?: string;
  timeMax?: string;
  q?: string;
  /** Google values: default, outOfOffice, focusTime, workingLocation, birthday, fromGmail. */
  eventTypes?: string[];
  orderBy: "startTime" | "updated";
  pageSize: number;
  pageToken?: string | null;
  /** IANA name for the times in the answer. */
  timeZone?: string;
}

export interface FreeBusyAnswer {
  /** Per requested calendar: busy intervals (RFC 3339), and whether Google could not read it. */
  calendars: Record<string, { busy: { start: string; end: string }[]; unavailable: boolean }>;
}

export interface CalendarService {
  listCalendars(
    a: AccountRef,
    q: { pageSize: number; pageToken?: string | null },
  ): Promise<Page<CalendarInfo>>;
  /** The IANA time zone of a calendar ("primary" works). */
  calendarTimeZone(a: AccountRef, calendarId: string): Promise<string>;
  listEvents(a: AccountRef, calendarId: string, q: ListEventsQuery): Promise<Page<EventInfo>>;
  getEvent(a: AccountRef, calendarId: string, eventId: string): Promise<EventInfo>;
  createEvent(
    a: AccountRef,
    calendarId: string,
    input: EventInput,
    sendUpdates: SendUpdates,
  ): Promise<EventInfo>;
  updateEvent(
    a: AccountRef,
    calendarId: string,
    eventId: string,
    patch: EventInput,
    sendUpdates: SendUpdates,
    /** The etag the caller planned the write on: the write fails if the event changed since. */
    ifMatch?: string,
  ): Promise<EventInfo>;
  deleteEvent(
    a: AccountRef,
    calendarId: string,
    eventId: string,
    sendUpdates: SendUpdates,
    ifMatch?: string,
  ): Promise<void>;
  /** Sets only the caller's own attendee entry; every other entry is sent back unchanged. */
  respond(
    a: AccountRef,
    calendarId: string,
    eventId: string,
    response: { status: "accepted" | "declined" | "tentative"; comment?: string },
    sendUpdates: SendUpdates,
  ): Promise<EventInfo>;
  freeBusy(
    a: AccountRef,
    q: { timeMin: string; timeMax: string; timeZone: string; calendarIds: string[] },
  ): Promise<FreeBusyAnswer>;
}

export const CALENDAR = capability<CalendarService>("calendar", "calendar");

// ---- time helpers ------------------------------------------------------------------------

export interface ParsedTime {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** Minutes east of UTC when the text carried an offset or `Z`. */
  offsetMinutes?: number;
  dateOnly: boolean;
}

const TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Parses `2026-04-30`, `2026-04-30T10:00:00`, with an optional `Z` or `+02:00`; null if invalid. */
export function parseTimeInput(text: string): ParsedTime | null {
  const m = TIME_RE.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  const out: ParsedTime = { y, m: mo, d, h, mi, s, dateOnly: m[4] === undefined };
  const z = m[7];
  if (z !== undefined) {
    if (z.toUpperCase() === "Z") out.offsetMinutes = 0;
    else {
      const digits = z.replace(":", "");
      const sign = digits.startsWith("-") ? -1 : 1;
      const hh = Number(digits.slice(1, 3));
      const mm = Number(digits.slice(3, 5));
      if (hh > 23 || mm > 59) return null;
      out.offsetMinutes = sign * (hh * 60 + mm);
    }
  }
  return out;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock fields of an instant in a zone. */
export function zonedParts(ms: number, tz: string): ParsedTime {
  const o: Record<string, number> = {};
  for (const p of zoneFormatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") o[p.type] = Number(p.value);
  }
  return {
    y: o.year as number,
    m: o.month as number,
    d: o.day as number,
    h: (o.hour as number) % 24,
    mi: o.minute as number,
    s: o.second as number,
    dateOnly: false,
  };
}

/** Milliseconds east of UTC that `tz` has at the instant `ms`. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant at which `tz` shows the wall-clock time `p` (the later one in a repeated hour). */
export function zonedToMs(
  p: Pick<ParsedTime, "y" | "m" | "d" | "h" | "mi" | "s">,
  tz: string,
): number {
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  let ms = wall - tzOffsetMs(wall, tz);
  const again = wall - tzOffsetMs(ms, tz);
  if (again !== ms) ms = again;
  return ms;
}

/** The instant of a parsed time: its own offset, else the wall clock of `tz`. Null if neither. */
export function toInstantMs(p: ParsedTime, tz: string | undefined): number | null {
  if (p.offsetMinutes !== undefined) {
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - p.offsetMinutes * 60_000;
  }
  return tz === undefined ? null : zonedToMs(p, tz);
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** `2026-04-30T10:00:00` for the wall-clock fields. */
export function localIso(p: Pick<ParsedTime, "y" | "m" | "d" | "h" | "mi" | "s">): string {
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** An instant as ISO text in `tz`, with its offset: `2026-04-30T10:00:00-07:00`. */
export function formatInTz(ms: number, tz: string): string {
  const off = Math.round(tzOffsetMs(ms, tz) / 60_000);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${localIso(zonedParts(ms, tz))}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
