"use client";

import { useState, useTransition, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Search, RefreshCw } from "lucide-react";
import {
  searchKnowledge,
  fetchRecentFacts,
  type KnowledgeResult,
  type Fact,
} from "./knowledge-server-actions";

const TYPE_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "outline"> = {
  fact: "secondary",
  person: "success",
  place: "warning",
};

function resultName(r: KnowledgeResult): string {
  const d = r.data ?? {};
  return (
    (d.name as string) ??
    (d.content as string) ??
    (d.title as string) ??
    r.summary ??
    r.entity_id
  );
}

function resultCategory(r: KnowledgeResult): string | undefined {
  const d = r.data ?? {};
  return (
    (d.category as string | undefined) ??
    (d.relationship as string | undefined) ??
    (d.type as string | undefined)
  );
}

export function KnowledgeView() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeResult[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [searched, setSearched] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const recent = await fetchRecentFacts();
      setFacts(recent);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    startTransition(async () => {
      const r = await searchKnowledge(query.trim());
      setResults(r);
      setSearched(true);
    });
  }

  function handleClear() {
    setQuery("");
    setResults([]);
    setSearched(false);
  }

  return (
    <div>
      <form onSubmit={handleSearch} className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search knowledge base..."
            className="pl-10"
          />
        </div>
        <Button type="submit" disabled={isPending || !query.trim()}>
          {isPending ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            "Search"
          )}
        </Button>
        {searched && (
          <Button type="button" variant="ghost" onClick={handleClear}>
            Clear
          </Button>
        )}
      </form>

      {searched ? (
        <div className="space-y-3">
          {results.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              No results found for &quot;{query}&quot;
            </p>
          ) : (
            results.map((r) => (
              <Card key={`${r.entity_type}-${r.entity_id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        variant={TYPE_VARIANT[r.entity_type] ?? "outline"}
                        className="shrink-0 text-xs"
                      >
                        {r.entity_type}
                      </Badge>
                      <span className="font-medium text-sm truncate">
                        {resultName(r)}
                      </span>
                    </div>
                    <span className="text-xs text-gray-400 shrink-0">
                      {Math.round(r.score * 100)}%
                    </span>
                  </div>
                  {resultCategory(r) && (
                    <Badge variant="outline" className="text-xs mt-2">
                      {resultCategory(r)}
                    </Badge>
                  )}
                  {r.summary && (
                    <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                      {r.summary}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      ) : (
        <div>
          <h2 className="text-sm font-medium text-gray-500 mb-3">
            Recent Facts
          </h2>
          {facts.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
                <Search className="h-12 w-12 mb-3" />
                <p className="text-sm">No knowledge recorded yet.</p>
                <p className="text-xs mt-1">
                  Tell Claude things about yourself and they will appear here.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {facts.map((f) => (
                <Card key={f.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge variant="secondary" className="shrink-0 text-xs">
                          {f.type ?? "fact"}
                        </Badge>
                        <span className="text-sm">{f.content}</span>
                      </div>
                      {f.confidence != null && (
                        <span className="text-xs text-gray-400 shrink-0">
                          {Math.round(f.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1 mt-2">
                      {f.category && (
                        <Badge variant="outline" className="text-xs">
                          {f.category}
                        </Badge>
                      )}
                      {f.tags?.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
