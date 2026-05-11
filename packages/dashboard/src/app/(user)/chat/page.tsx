import { ChatRoot } from "@/components/chat/chat-root";

export const metadata = { title: "Chat · LL5" };

// Render the shell immediately. State (convId + last messages) hydrates from
// localStorage cache on the client in <50ms; in parallel, the client fetches
// fresh from the server and merges. Previously this page did two sequential
// server-side round-trips on every visit (force-dynamic + cache:no-store),
// which is what produced the 5–30s cold-open lag.
export default function ChatPage() {
  return (
    <div className="h-full">
      <ChatRoot />
    </div>
  );
}
