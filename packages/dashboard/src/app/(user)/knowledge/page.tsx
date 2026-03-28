import { KnowledgeView } from "./knowledge-view";

export const metadata = { title: "Knowledge - LL5" };

export default function KnowledgePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Knowledge</h1>
      <KnowledgeView />
    </div>
  );
}
