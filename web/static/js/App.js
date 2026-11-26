import { createElement, Fragment } from 'preact';
import { QueryClientProvider } from './lib/query.js';
import { RouterProvider } from './lib/router.js';
import { registerNavigate } from './lib/navigation.js';
import { queryClient } from './lib/queryClient.js';
import { createAppRouter } from './routes.js';

const router = createAppRouter();
registerNavigate((to, opts) => void router.navigate(to, opts));

export function App() {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(RouterProvider, { router: router }),
  );
}
