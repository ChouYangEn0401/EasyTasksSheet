import { stubRouter } from '../../lib/stub.ts';

// Stub：由 feat/realtime-feedback 實作。
/** 掛載於 /api/changes：GET ?since=<id> */
export const changesRoutes = stubRouter('changes');
/** 掛載於 /api/events：SSE */
export const eventsRoutes = stubRouter('events');
