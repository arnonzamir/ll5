export interface PushMessage {
  id: string;
  userId: string;
  sender: string;
  app: string;
  content: string;
  processed: boolean;
  timestamp: string;
}

export interface MessageQuery {
  sender?: string;
  app?: string;
  startTime?: string;
  endTime?: string;
  keyword?: string;
  processed?: boolean;
  limit?: number;
  offset?: number;
}
