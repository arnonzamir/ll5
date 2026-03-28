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
        <LoginForm />
      </div>
    </div>
  );
}
