// An in-memory stand-in for the Prisma client, covering the calls the app makes. Each call
// yields once before it runs, so parallel calls interleave the way separate requests do.
export const SHOP = 'example.test';

const KEYS = {
  session: ['id'],
  shopState: ['shop'],
  campaignState: ['shop', 'campaignId'],
  campaignLock: ['shop', 'campaignId'],
};
const DEFAULTS = {
  campaignState: () => ({markers: '{}', targets: '{}', sentEvents: null, stampOperation: null, updatedAt: new Date()}),
};
const tables = Object.fromEntries(Object.keys(KEYS).map((name) => [name, []]));

const prismaError = (code, message) => Object.assign(new Error(message), {code});

function matches(row, where = {}) {
  return Object.entries(where).every(([field, condition]) => {
    if (condition === undefined) return true;
    if (field.includes('_')) return matches(row, condition);
    const value = row[field];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('in' in condition) return condition.in.includes(value);
      if ('lt' in condition) return value !== null && value < condition.lt;
      if ('not' in condition) return value !== condition.not;
      throw new Error(`The fake database doesn't support this filter on ${field}`);
    }
    return value instanceof Date ? value.getTime() === condition?.getTime?.() : value === condition;
  });
}

function apply(row, data) {
  for (const [field, value] of Object.entries(data)) {
    row[field] = value !== null && typeof value === 'object' && 'increment' in value ? row[field] + value.increment : value;
  }
  if ('updatedAt' in row) row.updatedAt = new Date();
  return row;
}

function model(name) {
  const rows = tables[name];
  const sameKey = (a, b) => KEYS[name].every((field) => a[field] === b[field]);
  const find = (where) => rows.find((row) => matches(row, where));
  const insert = (data) => {
    if (rows.some((row) => sameKey(row, data))) throw prismaError('P2002', `Unique constraint failed on ${name}`);
    const row = {...DEFAULTS[name]?.(), ...data};
    rows.push(row);
    return row;
  };
  // A microtask, which fake timers leave alone.
  const tick = () => Promise.resolve();
  return {
    findMany: async ({where} = {}) => (await tick(), rows.filter((row) => matches(row, where)).map((row) => ({...row}))),
    findUnique: async ({where}) => {
      await tick();
      const row = find(where);
      return row ? {...row} : null;
    },
    create: async ({data}) => (await tick(), {...insert(data)}),
    upsert: async ({where, create, update}) => {
      await tick();
      const row = find(where);
      return {...(row ? apply(row, update) : insert(create))};
    },
    update: async ({where, data}) => {
      await tick();
      const row = find(where);
      if (!row) throw prismaError('P2025', `No ${name} row to update`);
      return {...apply(row, data)};
    },
    updateMany: async ({where, data}) => {
      await tick();
      const hits = rows.filter((row) => matches(row, where));
      hits.forEach((row) => apply(row, data));
      return {count: hits.length};
    },
    deleteMany: async ({where} = {}) => {
      await tick();
      const before = rows.length;
      const kept = rows.filter((row) => !matches(row, where));
      rows.splice(0, rows.length, ...kept);
      return {count: before - kept.length};
    },
  };
}

export const db = {
  ...Object.fromEntries(Object.keys(KEYS).map((name) => [name, model(name)])),
  $transaction: async (work) => (typeof work === 'function' ? work(db) : Promise.all(work)),
};

export const tablesOf = () => tables;

export function resetDb() {
  for (const rows of Object.values(tables)) rows.length = 0;
}

// Writes a campaign's app-side record directly, as an earlier request would have.
export function seedState({campaignId, gid = 'gid://shopify/Metaobject/1', shop = SHOP, markers, targets, sentEvents}) {
  const rows = tables.campaignState;
  const index = rows.findIndex((row) => row.shop === shop && row.campaignId === campaignId);
  if (index >= 0) rows.splice(index, 1);
  rows.push({
    shop,
    campaignId,
    campaignGid: gid,
    markers: JSON.stringify(markers ?? {}),
    targets: JSON.stringify(targets ?? {}),
    sentEvents: sentEvents ?? null,
    updatedAt: new Date(),
  });
}

// A campaign's stored record, parsed. A missing row reads as empty.
export function storedState(campaignId, shop = SHOP) {
  const row = tables.campaignState.find((entry) => entry.shop === shop && entry.campaignId === campaignId);
  return {
    campaignGid: row?.campaignGid ?? null,
    markers: JSON.parse(row?.markers ?? '{}'),
    targets: JSON.parse(row?.targets ?? '{}'),
    sentEvents: row?.sentEvents ?? null,
  };
}
