export interface NormalizedEmail {
  id: number | string;
  subject: string;
  body: string;
  from: string;
  date?: string | Date;
  messageId?: string;
}

export interface ImapConnectResult {
  connected: boolean;
  blocker?: string;
  message?: string;
}

export interface ImapSearchResult {
  success: boolean;
  emails?: NormalizedEmail[];
  blocker?: string;
  message?: string;
}
