import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users } from "lucide-react";

export const metadata = { title: "Users - LL5 Admin" };

export default function UsersPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">User Management</h1>
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-gray-400">
          <Users className="h-12 w-12 mb-3" />
          <p className="text-sm">User management coming soon</p>
          <p className="text-xs mt-1">
            Requires gateway endpoint for listing and creating users
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
