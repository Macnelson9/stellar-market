import RedisClient from "./redis";

interface CacheOptions {
  ttl?: number; // Time to live in seconds
  keyPrefix?: string;
}

interface CacheResult<T> {
  data: T;
  hit: boolean; // true if cache hit, false if cache miss
}

/**
 * Generic cache helper that checks Redis before executing a function
 * @param key - Cache key
 * @param ttl - Time to live in seconds
 * @param fn - Function to execute if cache miss
 * @returns Promise with data and cache hit status
 */
export async function cache<T>(
  key: string,
  ttl: number,
  fn: () => Promise<T>
): Promise<CacheResult<T>> {
  try {
    // Try to connect to Redis if not already connected
    if (!RedisClient.isRedisConnected()) {
      await RedisClient.connect();
    }

    const redis = RedisClient.getInstance();
    
    // Try to get cached data
    const cached = await redis.get(key);
    
    if (cached) {
      console.log(`Cache HIT for key: ${key}`);
      return {
        data: JSON.parse(cached) as T,
        hit: true,
      };
    }

    // Cache miss - execute the function
    console.log(`Cache MISS for key: ${key}`);
    const result = await fn();
    
    // Cache the result
    await redis.setex(key, ttl, JSON.stringify(result));
    console.log(`Cached data for key: ${key} with TTL: ${ttl}s`);
    
    return {
      data: result,
      hit: false,
    };
  } catch (error) {
    console.warn(`Cache error for key ${key}, falling back to direct execution:`, error);
    // Graceful degradation - execute the function directly
    const result = await fn();
    return {
      data: result,
      hit: false,
    };
  }
}

/**
 * Invalidate cache by key pattern
 * @param pattern - Redis key pattern (supports wildcards)
 */
export async function invalidateCache(pattern: string): Promise<void> {
  try {
    if (!RedisClient.isRedisConnected()) {
      console.log("Redis not connected, skipping cache invalidation");
      return;
    }

    const redis = RedisClient.getInstance();
    const keys = await redis.keys(pattern);
    
    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(`Invalidated ${keys.length} cache keys matching pattern: ${pattern}`);
    }
  } catch (error) {
    console.warn(`Cache invalidation error for pattern ${pattern}:`, error);
  }
}

/**
 * Invalidate cache by specific key
 * @param key - Cache key to invalidate
 */
export async function invalidateCacheKey(key: string): Promise<void> {
  try {
    if (!RedisClient.isRedisConnected()) {
      console.log("Redis not connected, skipping cache invalidation");
      return;
    }

    const redis = RedisClient.getInstance();
    await redis.del(key);
    console.log(`Invalidated cache key: ${key}`);
  } catch (error) {
    console.warn(`Cache invalidation error for key ${key}:`, error);
  }
}

/**
 * Generate cache key for job listings with query parameters
 */
export function generateJobsCacheKey(params: Record<string, any>): string {
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((result, key) => {
      if (params[key] !== undefined && params[key] !== null) {
        result[key] = params[key];
      }
      return result;
    }, {} as Record<string, any>);
  
  const paramString = JSON.stringify(sortedParams);
  return `jobs:list:${Buffer.from(paramString).toString("base64")}`;
}

/**
 * Generate cache key for user profile
 */
export function generateUserCacheKey(userId: string): string {
  return `user:profile:${userId}`;
}

/**
 * Generate cache key for single job
 */
export function generateJobCacheKey(jobId: string): string {
  return `job:single:${jobId}`;
}
/**
 * Generate cache key for job on-chain status
 */
export function generateJobOnChainStatusCacheKey(jobId: string): string {
  return `job:onchain-status:${jobId}`;
}
