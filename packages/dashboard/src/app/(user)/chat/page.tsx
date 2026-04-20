import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";
import type { Message } from "@/lib/chat/types";
import { ChatRoot } from "@/components/chat/chat-root";

interface ActiveRes {
  conversation_id?: string;
}
interface MessagesRes {
  messages?: Message[];
}

async function loadInitial(token: string): Promise<{ convId: string | null; messages: Message[] }> {
  // Server-side fetch skips the client-side waterfall on mount. If either
  // call fails we render empty and let the client recover via the
  // existing bootstrap path (the store's useEffect on mount).
  let convId: string | null = null;
  let messages: Message[] = [];

  try {
    const active = await fetch(`${env.GATEWAY_URL}/chat/conversations/active`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (active.ok) {
      const data = (await active.json()) as ActiveRes;
      if (data.conversation_id) convId = data.conversation_id;
    }
  } catch { /* noop */ }

  if (convId) {
    try {
      const history = await fetch(
        `${env.GATEWAY_URL}/chat/messages?conversation_id=${convId}&limit=200`,
        { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      );
      if (history.ok) {
        const data = (await history.json()) as MessagesRes;
        messages = data.messages ?? [];
      }
    } catch { /* noop */ }
  }

  return { convId, messages };
}

export const metadata = { title: "Chat · LL5" };

export default async function ChatPage() {
  // Middleware already redirects unauthenticated users, so the token is
  // present by the time we render. Belt-and-suspenders: pass an empty
  // seed if the cookie somehow vanished, and let the client bootstrap.
  const token = (await getToken()) ?? "";
  const { convId, messages } = token
    ? await loadInitial(token)
    : { convId: null, messages: [] };

  return (
    <div className="h-full">
      <ChatRoot initialConvId={convId} initialMessages={messages} />
    </div>
  );
}
