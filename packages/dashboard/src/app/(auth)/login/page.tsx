import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign In - LL5" };

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-primary">LL5</h1>
          <p className="mt-2 text-sm text-gray-500">Personal Assistant</p>
        </div>
        {/* useSearchParams in LoginForm requires a Suspense boundary so Next
            can bail out of SSG and stream on demand (Next 15 requirement). */}
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
