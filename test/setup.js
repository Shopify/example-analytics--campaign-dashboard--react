import {afterEach, beforeEach, vi} from 'vitest';
import {resetDb} from './helpers/db';

// Every suite runs against the in-memory database. Each test starts with it empty.
vi.mock('../app/db.server', async () => ({default: (await import('./helpers/db')).db}));

beforeEach(() => resetDb());
// A spy that fails one database call stays off the next test.
afterEach(() => vi.restoreAllMocks());
