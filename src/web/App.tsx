import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { registerNavigate } from './lib/navigation.ts';
import { queryClient } from './lib/queryClient.ts';
import { createAppRouter } from './routes.tsx';

const router = createAppRouter();
registerNavigate((to, opts) => void router.navigate(to, opts));

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
