import { Suspense } from "react";
import { STEP_UP_TTL_SECONDS } from "@/lib/sensitive";
import { VerifyForm } from "./verify-form";

export const metadata = { title: "Confirm identity - LL5" };

/**
 * Step-up page for the sensitive catalog (lib/sensitive.ts). Needs a login
 * session (it is not a public path); the middleware sends sessions here with
 * ?next=<sensitive path> when the ll5_stepup cookie is missing or expired.
 */
export default function VerifyPage() {
  return (
    <div className="flex justify-center py-10 px-4">
      <div className="w-full max-w-sm">
        {/* useSearchParams in VerifyForm needs a Suspense boundary (Next 15). */}
        <Suspense fallback={null}>
          <VerifyForm ttlMinutes={Math.round(STEP_UP_TTL_SECONDS / 60)} />
        </Suspense>
      </div>
    </div>
  );
}
