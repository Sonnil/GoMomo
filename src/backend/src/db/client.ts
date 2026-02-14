import pg from 'pg';
import { env } from '../config/env.js';

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
  process.exit(-1);
});

export { pool };

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run a callback inside a SERIALIZABLE transaction.
 * Provides the strongest isolation — prevents phantom reads and
 * write skew. Used for the booking confirmation path where
 * concurrent sessions could race for the same slot.
 *
 * Callers MUST be prepared for serialization failures (code 40001)
 * and retry the entire operation.
 */
export async function withSerializableTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = await getClient();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error: any) {
      await client.query('ROLLBACK');
      // 40001 = serialization_failure — safe to retry
      if (error.code === '40001' && attempt < maxRetries) {
        // Exponential backoff: 50ms, 100ms, 200ms…
        await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  // Should never reach here, but satisfy TS
  throw new Error('withSerializableTransaction: exhausted retries');
}
