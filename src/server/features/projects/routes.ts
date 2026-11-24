import { stubRouter } from '../../lib/stub.ts';

// Stub：由 core/auth-data 實作（掛載於 /api/projects）。
export const projectsRoutes = stubRouter('projects');
