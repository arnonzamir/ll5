import { KnowledgeView } from "./knowledge-view";

export const metadata = { title: "Knowledge - LL5" };

export default function KnowledgePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Knowledge</h1>
        <p className="text-sm text-gray-500 mt-1">Facts, preferences, and personal information</p>
      </div>
      <KnowledgeView />
    </div>
  );
}
