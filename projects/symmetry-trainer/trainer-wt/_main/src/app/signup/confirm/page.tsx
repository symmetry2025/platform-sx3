import { Suspense } from 'react';

import { SignupConfirmClient } from './SignupConfirmClient';

export default function SignupConfirmPage() {
  // Next.js requires useSearchParams() to be wrapped in Suspense (CSR bailout).
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center p-6 md:p-10">Проверяем ссылку…</div>}>
      <SignupConfirmClient />
    </Suspense>
  );
}

