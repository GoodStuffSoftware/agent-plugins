// Google Calendar binding of the calendar capability (Calendar API v3).

import { ToolError } from "../../core/errors";
import type {
  CalendarInfo,
  CalendarService,
  EventAttendee,
  EventInfo,
  EventInput,
  EventTime,
  SendUpdates,
} from "../../services/calendar";
import { gjson } from "./http";

const BASE = "https://www.googleapis.com/calendar/v3";

const ATTENDEE_FIELDS =
  "email,displayName,responseStatus,self,organizer,optional,resource,comment,additionalGuests";
const EVENT_FIELDS = [
  "id",
  "status",
  "summary",
  "description",
  "location",
  "start",
  "end",
  "htmlLink",
  "hangoutLink",
  "conferenceData(entryPoints(entryPointType,uri))",
  `attendees(${ATTENDEE_FIELDS})`,
  "organizer(email,displayName,self)",
  "recurrence",
  "recurringEventId",
  "eventType",
  "visibility",
  "transparency",
  "attachments(fileUrl,title)",
  "reminders",
  "colorId",
  "guestsCanInviteOthers",
  "guestsCanModify",
  "guestsCanSeeOtherGuests",
  "created",
  "updated",
].join(",");

interface GAttendee {
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

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attendees?: GAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  recurrence?: string[];
  recurringEventId?: string;
  eventType?: string;
  visibility?: string;
  transparency?: string;
  attachments?: { fileUrl: string; title?: string }[];
  reminders?: { useDefault?: boolean; overrides?: { method: string; minutes: number }[] };
  colorId?: string;
  guestsCanInviteOthers?: boolean;
  guestsCanModify?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  created?: string;
  updated?: string;
}

const EVENT_TYPE_OUT: Record<string, string> = {
  DEFAULT: "default",
  OUT_OF_OFFICE: "outOfOffice",
  FOCUS_TIME: "focusTime",
  WORKING_LOCATION: "workingLocation",
  BIRTHDAY: "birthday",
  FROM_GMAIL: "fromGmail",
};
const EVENT_TYPE_IN: Record<string, string> = Object.fromEntries(
  Object.entries(EVENT_TYPE_OUT).map(([k, v]) => [v, k]),
);

const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function attendeeIn(a: GAttendee): EventAttendee {
  return defined({
    email: a.email,
    displayName: a.displayName,
    responseStatus: a.responseStatus,
    self: a.self,
    organizer: a.organizer,
    optional: a.optional,
    resource: a.resource,
    comment: a.comment,
    additionalGuests: a.additionalGuests,
  });
}

/** The writable attendee fields only. */
function attendeeOut(a: EventAttendee): GAttendee {
  return defined({
    email: a.email,
    displayName: a.displayName,
    responseStatus: a.responseStatus,
    optional: a.optional,
    resource: a.resource,
    comment: a.comment,
    additionalGuests: a.additionalGuests,
  });
}

function toEvent(e: GEvent): EventInfo {
  const meet =
    e.hangoutLink ??
    e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  const guest = defined({
    guestsCanInviteOthers: e.guestsCanInviteOthers,
    guestsCanModify: e.guestsCanModify,
    guestsCanSeeGuests: e.guestsCanSeeOtherGuests,
  });
  return defined({
    id: e.id,
    status: e.status,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start,
    end: e.end,
    htmlLink: e.htmlLink,
    meetUrl: meet,
    attendees: e.attendees?.map(attendeeIn),
    organizer: e.organizer,
    recurrence: e.recurrence,
    recurringEventId: e.recurringEventId,
    eventType: e.eventType === undefined ? undefined : (EVENT_TYPE_IN[e.eventType] ?? e.eventType),
    visibility: e.visibility,
    availability: e.transparency === "transparent" ? "FREE" : "BUSY",
    attachments: e.attachments,
    reminders:
      e.reminders === undefined
        ? undefined
        : defined({ useDefault: e.reminders.useDefault === true, overrides: e.reminders.overrides }),
    colorId: e.colorId,
    guestPermissions: Object.keys(guest).length > 0 ? guest : undefined,
    created: e.created,
    updated: e.updated,
  });
}

const WORKING_TYPE: Record<string, string> = {
  HOME_OFFICE: "homeOffice",
  CUSTOM_LOCATION: "customLocation",
  OFFICE_LOCATION: "officeLocation",
};

/** The Google event body for the parts of `i` that are present. */
function toBody(i: EventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (i.summary !== undefined) body.summary = i.summary;
  if (i.description !== undefined) body.description = i.description;
  if (i.location !== undefined) body.location = i.location;
  if (i.start !== undefined) body.start = i.start;
  if (i.end !== undefined) body.end = i.end;
  if (i.attendees !== undefined) body.attendees = i.attendees.map(attendeeOut);
  if (i.recurrence !== undefined) body.recurrence = i.recurrence;
  if (i.attachments !== undefined) body.attachments = i.attachments;
  if (i.reminders !== undefined) {
    body.reminders = defined({ useDefault: i.reminders.useDefault, overrides: i.reminders.overrides });
  }
  if (i.colorId !== undefined) body.colorId = i.colorId;
  if (i.visibility !== undefined) body.visibility = i.visibility;
  if (i.availability !== undefined) {
    body.transparency = i.availability === "FREE" ? "transparent" : "opaque";
  }
  if (i.eventType !== undefined) body.eventType = EVENT_TYPE_OUT[i.eventType] ?? i.eventType;
  if (i.guestPermissions !== undefined) {
    const g = i.guestPermissions;
    Object.assign(
      body,
      defined({
        guestsCanInviteOthers: g.guestsCanInviteOthers,
        guestsCanModify: g.guestsCanModify,
        guestsCanSeeOtherGuests: g.guestsCanSeeGuests,
      }),
    );
  }
  if (i.addMeet === true) {
    body.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }
  if (i.workingLocation !== undefined) {
    const w = i.workingLocation;
    const type = WORKING_TYPE[w.type ?? "HOME_OFFICE"] ?? "homeOffice";
    body.workingLocationProperties = defined({
      type,
      homeOffice: type === "homeOffice" ? {} : undefined,
      customLocation:
        type === "customLocation" ? { label: w.customLocationLabel ?? "" } : undefined,
      officeLocation: type === "officeLocation" ? defined({ ...w.officeLocation }) : undefined,
    });
  }
  return body;
}

const enc = encodeURIComponent;
const eventUrl = (cal: string, id?: string): string =>
  `${BASE}/calendars/${enc(cal)}/events${id === undefined ? "" : `/${enc(id)}`}`;

export const googleCalendar: CalendarService = {
  async listCalendars(a, q) {
    const r = await gjson<{ nextPageToken?: string; items?: CalendarInfo[] }>(
      a,
      `${BASE}/users/me/calendarList`,
      {},
      {
        fields:
          "nextPageToken,items(id,summary,summaryOverride,description,primary,accessRole,timeZone,selected,hidden,backgroundColor)",
        query: { maxResults: q.pageSize, pageToken: q.pageToken },
      },
    );
    const page = { items: (r?.items ?? []).map((c) => defined(c)) } as {
      items: CalendarInfo[];
      nextPageToken?: string;
    };
    if (r?.nextPageToken) page.nextPageToken = r.nextPageToken;
    return page;
  },

  async calendarTimeZone(a, calendarId) {
    const r = await gjson<{ timeZone?: string }>(
      a,
      `${BASE}/calendars/${enc(calendarId)}`,
      {},
      { fields: "timeZone" },
    );
    return r?.timeZone ?? "UTC";
  },

  async listEvents(a, calendarId, q) {
    const r = await gjson<{ nextPageToken?: string; items?: GEvent[] }>(
      a,
      eventUrl(calendarId),
      {},
      {
        fields: `nextPageToken,items(${EVENT_FIELDS})`,
        query: {
          singleEvents: true,
          orderBy: q.orderBy,
          timeMin: q.timeMin,
          timeMax: q.timeMax,
          q: q.q,
          eventTypes: q.eventTypes,
          maxResults: q.pageSize,
          pageToken: q.pageToken,
          timeZone: q.timeZone,
        },
      },
    );
    const page: { items: EventInfo[]; nextPageToken?: string } = {
      items: (r?.items ?? []).map(toEvent),
    };
    if (r?.nextPageToken) page.nextPageToken = r.nextPageToken;
    return page;
  },

  async getEvent(a, calendarId, eventId) {
    const e = await gjson<GEvent>(a, eventUrl(calendarId, eventId), {}, { fields: EVENT_FIELDS });
    if (!e) throw new ToolError("upstream_error", "Google answered with an empty body.");
    return toEvent(e);
  },

  async createEvent(a, calendarId, input, sendUpdates) {
    const e = await gjson<GEvent>(
      a,
      eventUrl(calendarId),
      { method: "POST", json: toBody(input) },
      {
        fields: EVENT_FIELDS,
        query: { sendUpdates, supportsAttachments: true, conferenceDataVersion: 1 },
      },
    );
    if (!e) throw new ToolError("upstream_error", "Google answered with an empty body.");
    return toEvent(e);
  },

  async updateEvent(a, calendarId, eventId, patch, sendUpdates) {
    const e = await gjson<GEvent>(
      a,
      eventUrl(calendarId, eventId),
      { method: "PATCH", json: toBody(patch) },
      {
        fields: EVENT_FIELDS,
        query: { sendUpdates, supportsAttachments: true, conferenceDataVersion: 1 },
      },
    );
    if (!e) throw new ToolError("upstream_error", "Google answered with an empty body.");
    return toEvent(e);
  },

  async deleteEvent(a, calendarId, eventId, sendUpdates) {
    await gjson<undefined>(
      a,
      eventUrl(calendarId, eventId),
      { method: "DELETE" },
      { query: { sendUpdates } },
    );
  },

  async respond(a, calendarId, eventId, response, sendUpdates) {
    const cur = await gjson<{ attendees?: GAttendee[] }>(
      a,
      eventUrl(calendarId, eventId),
      {},
      { fields: `attendees(${ATTENDEE_FIELDS})` },
    );
    const list = cur?.attendees ?? [];
    if (!list.some((x) => x.self === true)) {
      throw new ToolError(
        "invalid_argument",
        "This account is not an attendee of the event, so it has no response to set.",
      );
    }
    // Google replaces the attendee list on a patch: send every entry back, change only our own.
    const attendees = list.map((x) =>
      x.self === true
        ? attendeeOut({
            ...attendeeIn(x),
            responseStatus: response.status,
            ...(response.comment === undefined ? {} : { comment: response.comment }),
          })
        : attendeeOut(attendeeIn(x)),
    );
    const e = await gjson<GEvent>(
      a,
      eventUrl(calendarId, eventId),
      { method: "PATCH", json: { attendees } },
      { fields: EVENT_FIELDS, query: { sendUpdates } },
    );
    if (!e) throw new ToolError("upstream_error", "Google answered with an empty body.");
    return toEvent(e);
  },

  async freeBusy(a, q) {
    const r = await gjson<{
      calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
    }>(
      a,
      `${BASE}/freeBusy`,
      {
        method: "POST",
        json: {
          timeMin: q.timeMin,
          timeMax: q.timeMax,
          timeZone: q.timeZone,
          items: q.calendarIds.map((id) => ({ id })),
        },
      },
      { fields: "calendars", retry: true },
    );
    const out: Record<string, { busy: { start: string; end: string }[]; unavailable: boolean }> =
      {};
    for (const id of q.calendarIds) {
      const c = r?.calendars?.[id];
      out[id] = {
        busy: (c?.busy ?? []).map((b) => ({ start: b.start, end: b.end })),
        unavailable: c === undefined || (c.errors?.length ?? 0) > 0,
      };
    }
    return { calendars: out };
  },
};
