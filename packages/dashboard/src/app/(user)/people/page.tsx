import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { mcpCallList } from "@/lib/api";
import { Users } from "lucide-react";

export const metadata = { title: "People - LL5" };

interface Person {
  id: string;
  name: string;
  aliases?: string[];
  relationship?: string;
  notes?: string;
  tags?: string[];
}

const RELATIONSHIP_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "outline"> = {
  family: "warning",
  friend: "success",
  colleague: "default",
  acquaintance: "secondary",
};

export default async function PeoplePage() {
  const items = await mcpCallList<Person>("knowledge", "list_people");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">People</h1>
      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
            <Users className="h-12 w-12 mb-3" />
            <p className="text-sm">No people recorded yet.</p>
            <p className="text-xs mt-1">
              Tell Claude about the people in your life.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((p) => (
            <Card key={p.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-sm truncate">
                    {p.name}
                  </span>
                  {p.relationship && (
                    <Badge
                      variant={RELATIONSHIP_VARIANT[p.relationship] ?? "outline"}
                      className="shrink-0 text-xs"
                    >
                      {p.relationship}
                    </Badge>
                  )}
                </div>
                {p.aliases && p.aliases.length > 0 && (
                  <p className="text-xs text-gray-400 mt-1 truncate">
                    {p.aliases.join(", ")}
                  </p>
                )}
                {p.notes && (
                  <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                    {p.notes}
                  </p>
                )}
                {p.tags && p.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {p.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
