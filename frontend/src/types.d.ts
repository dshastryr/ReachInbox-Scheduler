export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EmailStatus = "SCHEDULED" | "PROCESSING" | "SENT" | "FAILED";

export interface EmailJob {
  id: string;
  status: EmailStatus;
  recipientEmail: string;
  subject: string;
  sender: { id: string; name: string; email: string };
  campaign: { id: string; name: string | null } | null;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
}

export interface Campaign {
  id: string;
  name: string | null;
  subject: string;
  startAt: string;
  delayMs: number;
  hourlyLimit: number;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  total: number;
  items: EmailJob[];
}

export interface EmailStats {
  total: number;
  scheduled: number;
  processing: number;
  sent: number;
  failed: number;
}

export interface SlackConnection {
  connected: boolean;
  teamId: string | null;
  teamName: string | null;
}
