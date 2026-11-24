import { stubRouter } from '../../lib/stub.ts';

// Stub：由 feat/admin-users 實作（掛載於 /api/admin）。
export const adminRoutes = stubRouter('admin');
