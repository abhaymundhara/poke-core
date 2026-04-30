export type MailProvider = 'gmail' | 'outlook';
export type CalendarProvider = 'google' | 'outlook';

export type RuntimeSearchHit = {
  provider: MailProvider;
  messageId: string;
  threadId?: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date?: string;
  snippet: string;
  hasAttachment: boolean;
  unread: boolean;
  raw: unknown;
  score: number;
};

export type EmailDraftIntent = {
  mode: 'new' | 'reply' | 'forward';
  userEmailAddressToSendFrom: string;
  instructions?: string;
  recipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  sourceMessageId?: string;
  provider?: MailProvider;
  mediaIds?: string[];
  preferThreadSearch?: boolean;
};

export type EmailDraftResult = {
  provider: MailProvider;
  draftId: string;
  mode: EmailDraftIntent['mode'];
  sourceMessageId?: string;
  subject: string;
  bodyPreview: string;
  recipients: string[];
  ccRecipients: string[];
  bccRecipients: string[];
  raw: unknown;
};

export type CalendarEventRecord = {
  provider: CalendarProvider;
  eventId: string;
  calendarId?: string;
  title: string;
  start: string;
  end: string;
  timezone?: string;
  attendees: string[];
  location?: string;
  description?: string;
  organizer?: string;
  raw: unknown;
};

export type CalendarDraftIntent = {
  type: 'new' | 'update';
  userEmailAddressToSendFrom: string;
  provider?: CalendarProvider;
  calendarId?: string;
  title?: string;
  startDateTime?: string;
  endDateTime?: string;
  timezone?: string;
  attendees?: string[];
  description?: string;
  location?: string;
  addConference?: boolean;
  recurrence?: string[] | null;
  searchQuery?: string;
};

export type CalendarDraftResult = {
  provider: CalendarProvider;
  draftId: string;
  title: string;
  startDateTime?: string;
  endDateTime?: string;
  timezone?: string;
  conflicts: Array<{ eventId: string; title: string; start: string; end: string; calendarId?: string }>;
  raw: unknown;
};

export type FilesystemNode = {
  path: string;
  kind: 'file' | 'directory';
  size: number;
  hash?: string;
  updatedAt?: number;
};

export type FilesystemDiff = {
  path: string;
  change: 'create' | 'update' | 'delete';
  before?: string;
  after?: string;
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
};

export type FilesystemSnapshot = {
  root: string;
  capturedAt: number;
  nodes: FilesystemNode[];
};
