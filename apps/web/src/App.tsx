/**
 * Application root: providers, then routes.
 *
 * Provider order matters — theme and session must wrap the router so every
 * screen can read them.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { SessionGate } from '@/app/SessionGate';
import { SessionProvider } from '@/app/session';
import { ThemeProvider } from '@/app/theme';
import { AppRoutes } from '@/app/router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * ERP data is shared and changes under you: a colleague posts an invoice
       * while you are looking at the customer. A short stale time keeps figures
       * reasonably fresh without hammering the server on every focus change.
       * Financial screens can override this per query when they need it tighter.
       */
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SessionProvider>
          <BrowserRouter>
            {/*
              The gate sits inside the router so the sign-in and company screens can use links,
              and outside the routes so no application route exists for a signed-out browser to
              reach. The server is still what refuses the requests; this is what stops the
              browser making them.
            */}
            <SessionGate>
              <AppRoutes />
            </SessionGate>
          </BrowserRouter>
        </SessionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
