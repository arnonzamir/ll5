import { ResetForm } from "./reset-form";

export const metadata = { title: "Reset Password - LL5" };

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-primary">LL5</h1>
          <p className="mt-2 text-sm text-gray-500">Personal Assistant</p>
        </div>
        <ResetForm token={token ?? ""} />
      </div>
    </div>
  );
}
