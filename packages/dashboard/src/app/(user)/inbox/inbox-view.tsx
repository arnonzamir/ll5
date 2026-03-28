"use client";

import { useState, useTransition, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InboxItem } from "@/components/inbox-item";
import { Plus, RefreshCw } from "lucide-react";
import { fetchInbox, captureInbox } from "./inbox-server-actions";

interface InboxEntry {
  id: string;
  title: string;
  source?: string | null;
  captured_at?: string | null;
}

export function InboxView() {
  const [items, setItems] = useState<InboxEntry[]>([]);
  const [isPending, startTransition] = useTransition();
  const [captureText, setCaptureText] = useState("");

  function loadInbox() {
    startTransition(async () => {
      const result = await fetchInbox();
      setItems(result);
    });
  }

  useEffect(() => {
    loadInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleCapture(e: React.FormEvent) {
    e.preventDefault();
    if (!captureText.trim()) return;
    const text = captureText;
    setCaptureText("");
    startTransition(async () => {
      await captureInbox(text);
      loadInbox();
    });
  }

  return (
    <div>
      {/* Quick capture */}
      <form onSubmit={handleCapture} className="flex gap-2 mb-4">
        <Input
          value={captureText}
          onChange={(e) => setCaptureText(e.target.value)}
          placeholder="Quick capture..."
          className="flex-1"
        />
        <Button type="submit" disabled={isPending || !captureText.trim()}>
          <Plus className="h-4 w-4 mr-1" />
          Capture
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={loadInbox}
          disabled={isPending}
          aria-label="Refresh inbox"
        >
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>
      </form>

      {/* Inbox list */}
      <div className="rounded-lg border border-gray-200 bg-white">
        {items.length === 0 ? (
          <p className="p-6 text-sm text-gray-500 text-center">
            {isPending ? "Loading..." : "Inbox empty"}
          </p>
        ) : (
          items.map((item) => (
            <InboxItem
              key={item.id}
              title={item.title}
              source={item.source}
              capturedAt={item.captured_at}
            />
          ))
        )}
      </div>
    </div>
  );
}
