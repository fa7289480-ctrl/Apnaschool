/**
 * Minimal in-memory Prisma double for auth integration tests.
 *
 * It implements only the queries the auth/users routes and session service
 * actually issue. The goal is to exercise the real Express middleware, Zod
 * schemas, Argon2 hashing, token hashing and cookie handling without requiring
 * a PostgreSQL server. It is NOT a general Prisma emulator.
 */

type Row = Record<string, any>;

interface Store {
  users: Row[];
  schools: Row[];
  sessions: Row[];
  tokens: Row[];
  auditLogs: Row[];
  teachers: Row[];
  parents: Row[];
  students: Row[];
  classes: Row[];
}

const store: Store = {
  users: [],
  schools: [],
  sessions: [],
  tokens: [],
  auditLogs: [],
  teachers: [],
  parents: [],
  students: [],
  classes: [],
};

let sequence = 0;
let failAuditWrites = false;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${String(sequence).padStart(4, '0')}`;
}

function prismaError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'NOT') return !matches(row, value as Row);
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const operators = value as Row;
      if ('not' in operators && row[key] === operators.not) return false;
      if ('equals' in operators) {
        const eq = operators.equals;
        if (operators.mode === 'insensitive' && typeof row[key] === 'string' && typeof eq === 'string') {
          return row[key].toLowerCase() === eq.toLowerCase();
        }
        return row[key] === eq;
      }
      if ('gt' in operators && !(row[key] instanceof Date && row[key].getTime() > new Date(operators.gt).getTime())) return false;
      if ('gte' in operators && !(row[key] instanceof Date && row[key].getTime() >= new Date(operators.gte).getTime())) return false;
      if ('lt' in operators && !(row[key] instanceof Date && row[key].getTime() < new Date(operators.lt).getTime())) return false;
      if ('lte' in operators && !(row[key] instanceof Date && row[key].getTime() <= new Date(operators.lte).getTime())) return false;
      return true;
    }
    return row[key] === value;
  });
}

function applyOrder<T extends Row>(rows: T[], orderBy?: Row): T[] {
  if (!orderBy) return rows;
  const [field, direction] = Object.entries(orderBy)[0] ?? [];
  if (!field) return rows;
  return [...rows].sort((a, b) => {
    const av = a[field] instanceof Date ? a[field].getTime() : a[field];
    const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * (direction === 'desc' ? -1 : 1);
  });
}

function makeUser(data: Row): Row {
  const stamp = new Date();
  return {
    id: nextId('user'),
    publicCode: data.publicCode ?? null,
    username: data.username ?? null,
    email: data.email,
    passwordHash: data.passwordHash,
    firstName: data.firstName,
    lastName: data.lastName,
    role: data.role ?? 'SCHOOL_ADMIN',
    schoolId: data.schoolId ?? null,
    isActive: data.isActive ?? true,
    mustChangePassword: data.mustChangePassword ?? false,
    emailVerifiedAt: data.emailVerifiedAt ?? null,
    lastLoginAt: data.lastLoginAt ?? null,
    failedLoginAttempts: data.failedLoginAttempts ?? 0,
    lockedUntil: data.lockedUntil ?? null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function makeSchool(data: Row): Row {
  const stamp = new Date();
  return {
    id: nextId('school'),
    publicCode: data.publicCode ?? null,
    name: data.name,
    address: data.address ?? null,
    city: data.city ?? null,
    phone: data.phone ?? null,
    email: data.email ?? null,
    website: data.website ?? null,
    status: data.status ?? 'PENDING',
    trialStartsAt: data.trialStartsAt ?? null,
    trialEndsAt: data.trialEndsAt ?? null,
    plan: data.plan ?? null,
    planExpiresAt: data.planExpiresAt ?? null,
    approvedBy: data.approvedBy ?? null,
    approvedAt: data.approvedAt ?? null,
    rejectionReason: data.rejectionReason ?? null,
    deactivatedAt: data.deactivatedAt ?? null,
    deactivationReason: data.deactivationReason ?? null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function makeToken(data: Row): Row {
  return {
    id: nextId('token'),
    userId: data.userId,
    type: data.type,
    tokenHash: data.tokenHash,
    expiresAt: data.expiresAt,
    consumedAt: data.consumedAt ?? null,
    createdAt: new Date(),
  };
}

function makeSession(data: Row): Row {
  return {
    id: nextId('session'),
    userId: data.userId,
    token: data.token,
    expiresAt: data.expiresAt,
    ipAddress: data.ipAddress ?? null,
    userAgent: data.userAgent ?? null,
    createdAt: new Date(),
  };
}

function makeAuditLog(data: Row): Row {
  return {
    id: nextId('audit'),
    ...data,
    createdAt: new Date(),
  };
}

const prisma = {
  user: {
    async findUnique({ where }: { where: Row }) {
      return store.users.find((user) => matches(user, where)) ?? null;
    },
    async findFirst({ where }: { where: Row }) {
      return store.users.find((user) => matches(user, where)) ?? null;
    },
    async count({ where }: { where?: Row } = {}) {
      return store.users.filter((user) => matches(user, where)).length;
    },
    async findMany({
      where,
      orderBy,
      take,
    }: { where?: Row; orderBy?: Row; take?: number } = {}) {
      let rows = store.users.filter((user) => matches(user, where));
      rows = applyOrder(rows, orderBy);
      return take ? rows.slice(0, take) : rows;
    },
    async create({ data }: { data: Row }) {
      if (store.users.some((user) => user.email === data.email)) {
        throw prismaError('P2002', 'Unique constraint failed on the fields: (`email`)');
      }
      const row = makeUser(data);
      store.users.push(row);
      return row;
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const index = store.users.findIndex((user) => matches(user, where));
      if (index === -1) {
        throw prismaError('P2025', 'An operation failed because it depends on one or more records that were required but not found.');
      }
      const current = store.users[index];
      const updated = {
        ...current,
        ...data,
        updatedAt: new Date(),
      };
      store.users[index] = updated;
      return updated;
    },
  },

  school: {
    async findUnique({ where }: { where: Row }) {
      return store.schools.find((school) => matches(school, where)) ?? null;
    },
    async findFirst({ where }: { where: Row }) {
      return store.schools.find((school) => matches(school, where)) ?? null;
    },
    async count({ where }: { where?: Row } = {}) {
      return store.schools.filter((school) => matches(school, where)).length;
    },
    async findMany({
      where,
      orderBy,
      take,
    }: { where?: Row; orderBy?: Row; take?: number } = {}) {
      let rows = store.schools.filter((school) => matches(school, where));
      rows = applyOrder(rows, orderBy);
      return take ? rows.slice(0, take) : rows;
    },
    async create({ data }: { data: Row }) {
      const row = makeSchool(data);
      store.schools.push(row);
      return row;
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = store.schools.find((school) => matches(school, where));
      if (!row) throw prismaError('P2025', 'Record to update not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  },

  teacher: {
    async create({ data }: { data: Row }) {
      const row = { id: nextId('teacher'), ...data, createdAt: new Date(), updatedAt: new Date() };
      store.teachers.push(row);
      return row;
    },
  },

  parent: {
    async findFirst({ where }: { where: Row }) {
      return store.parents.find((parent) => matches(parent, where)) ?? null;
    },
    async create({ data }: { data: Row }) {
      const row = { id: nextId('parent'), ...data, createdAt: new Date(), updatedAt: new Date() };
      store.parents.push(row);
      return row;
    },
  },

  student: {
    async findFirst({ where }: { where: Row }) {
      return store.students.find((student) => matches(student, where)) ?? null;
    },
    async create({ data }: { data: Row }) {
      const row = { id: nextId('student'), ...data, guardianVerified: false, isActive: true, createdAt: new Date(), updatedAt: new Date() };
      store.students.push(row);
      return row;
    },
  },

  class: {
    async findFirst({ where }: { where: Row }) {
      return store.classes.find((item) => matches(item, where)) ?? null;
    },
  },

  platformSetting: {
    async findUnique() {
      return null;
    },
  },

  session: {
    async create({ data }: { data: Row }) {
      if (store.sessions.some((session) => session.token === data.token)) {
        throw prismaError('P2002', 'Unique constraint failed on the fields: (`token`)');
      }
      const row = makeSession(data);
      store.sessions.push(row);
      return row;
    },
    async findUnique({ where, include }: { where: Row; include?: Row }) {
      const session = store.sessions.find((row) => matches(row, where));
      if (!session) return null;
      if (!include?.user) return session;
      return {
        ...session,
        user: store.users.find((user) => user.id === session.userId) ?? null,
      };
    },
    async delete({ where }: { where: Row }) {
      const index = store.sessions.findIndex((row) => matches(row, where));
      if (index === -1) {
        throw prismaError('P2025', 'Record to delete does not exist.');
      }
      return store.sessions.splice(index, 1)[0];
    },
    async deleteMany({ where }: { where: Row }) {
      const before = store.sessions.length;
      store.sessions = store.sessions.filter((row) => !matches(row, where));
      return { count: before - store.sessions.length };
    },
  },

  token: {
    async create({ data }: { data: Row }) {
      if (store.tokens.some((token) => token.tokenHash === data.tokenHash)) {
        throw prismaError('P2002', 'Unique constraint failed on the fields: (`tokenHash`)');
      }
      const row = makeToken(data);
      store.tokens.push(row);
      return row;
    },
    async findUnique({ where }: { where: Row }) {
      return store.tokens.find((token) => matches(token, where)) ?? null;
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const index = store.tokens.findIndex((token) => matches(token, where));
      if (index === -1) {
        throw prismaError('P2025', 'Record to update not found.');
      }
      const updated = { ...store.tokens[index], ...data };
      store.tokens[index] = updated;
      return updated;
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      let count = 0;
      store.tokens = store.tokens.map((token) => {
        if (!matches(token, where)) return token;
        count += 1;
        return { ...token, ...data };
      });
      return { count };
    },
    async deleteMany({ where }: { where: Row }) {
      const before = store.tokens.length;
      store.tokens = store.tokens.filter((row) => !matches(row, where));
      return { count: before - store.tokens.length };
    },
  },

  auditLog: {
    async create({ data }: { data: Row }) {
      if (failAuditWrites) throw new Error('simulated audit database failure');
      const row = makeAuditLog(data);
      store.auditLogs.push(row);
      return row;
    },
  },

  async $transaction(arg: unknown) {
    if (typeof arg === 'function') {
      // Snapshot the disposable in-memory store so failed callbacks emulate
      // transaction rollback for route/unit tests. This is not a PostgreSQL
      // substitute and cannot prove database locking/isolation semantics.
      const snapshot = {
        users: store.users.map((row) => ({ ...row })),
        schools: store.schools.map((row) => ({ ...row })),
        sessions: store.sessions.map((row) => ({ ...row })),
        tokens: store.tokens.map((row) => ({ ...row })),
        auditLogs: store.auditLogs.map((row) => ({ ...row })),
        teachers: store.teachers.map((row) => ({ ...row })),
        parents: store.parents.map((row) => ({ ...row })),
        students: store.students.map((row) => ({ ...row })),
        classes: store.classes.map((row) => ({ ...row })),
      };
      try {
        return await (arg as (tx: typeof prisma) => Promise<unknown>)(prisma);
      } catch (error) {
        store.users.splice(0, store.users.length, ...snapshot.users);
        store.schools.splice(0, store.schools.length, ...snapshot.schools);
        store.sessions.splice(0, store.sessions.length, ...snapshot.sessions);
        store.tokens.splice(0, store.tokens.length, ...snapshot.tokens);
        store.auditLogs.splice(0, store.auditLogs.length, ...snapshot.auditLogs);
        store.teachers.splice(0, store.teachers.length, ...snapshot.teachers);
        store.parents.splice(0, store.parents.length, ...snapshot.parents);
        store.students.splice(0, store.students.length, ...snapshot.students);
        store.classes.splice(0, store.classes.length, ...snapshot.classes);
        throw error;
      }
    }
    return Promise.all(arg as Promise<unknown>[]);
  },

  async $queryRaw() {
    return [{ '?column?': 1 }];
  },

  async $disconnect() {
    // no-op
  },

  /** Test-only helpers, never used by application code. */
  __reset() {
    store.users.length = 0;
    store.schools.length = 0;
    store.sessions.length = 0;
    store.tokens.length = 0;
    store.auditLogs.length = 0;
    store.teachers.length = 0;
    store.parents.length = 0;
    store.students.length = 0;
    store.classes.length = 0;
    sequence = 0;
    failAuditWrites = false;
  },
  __setAuditFailure(value: boolean) {
    failAuditWrites = value;
  },
  __store() {
    return store;
  },
  __findUserByEmail(email: string) {
    return store.users.find((user) => user.email === email) ?? null;
  },
  __tokensFor(userId: string, type?: string) {
    return store.tokens.filter(
      (token) => token.userId === userId && (!type || token.type === type),
    );
  },
  __sessionsFor(userId: string) {
    return store.sessions.filter((session) => session.userId === userId);
  },
};

export const fakePrisma = prisma;
export function resetFakePrisma(): void {
  prisma.__reset();
}
