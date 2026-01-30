import { defineHook } from '@directus/extensions-sdk';
import Redis from 'ioredis';

const STREAM_NAME = 'search:sync';

// Collections that should trigger search sync
const SEARCHABLE_SUFFIXES = ['_products', '_categories'];

/**
 * Check if a collection should trigger search sync
 */
function isSearchable(collection: string): boolean {
	return SEARCHABLE_SUFFIXES.some((suffix) => collection.endsWith(suffix));
}

/**
 * Extract dealer slug from collection name
 * e.g., "pntl_products" -> "pntl"
 */
function extractDealer(collection: string): string {
	for (const suffix of SEARCHABLE_SUFFIXES) {
		if (collection.endsWith(suffix)) {
			return collection.slice(0, -suffix.length);
		}
	}
	return collection;
}

/**
 * Get entity type from collection name
 * e.g., "pntl_products" -> "products"
 */
function getEntityType(collection: string): string {
	for (const suffix of SEARCHABLE_SUFFIXES) {
		if (collection.endsWith(suffix)) {
			return suffix.slice(1); // Remove leading underscore
		}
	}
	return 'unknown';
}

export default defineHook(({ action }, { env, logger }) => {
	let redis: Redis | null = null;
	let isConnected = false;

	// Check for Redis URL - try multiple env var names
	const redisUrl = env['REDIS_URL'] || env['REDIS_CONNECTION_STRING'] || process.env.REDIS_URL;
	
	logger.info(`Search sync: Initializing (REDIS_URL ${redisUrl ? 'found' : 'NOT FOUND'})`);
	
	if (!redisUrl) {
		logger.warn('Search sync: No Redis URL configured - extension disabled');
		logger.warn(`Search sync: Available env keys: ${Object.keys(env).join(', ')}`);
		return;
	}

	try {
		// Parse URL to check for TLS (rediss://)
		const isTLS = redisUrl.startsWith('rediss://');
		
		redis = new Redis(redisUrl, {
			maxRetriesPerRequest: 3,
			retryStrategy(times) {
				if (times > 5) {
					logger.warn('Search sync: Redis connection failed after 5 retries - disabling');
					return null;
				}
				return Math.min(times * 200, 2000);
			},
			// TLS options for DigitalOcean Managed Redis
			tls: isTLS ? { rejectUnauthorized: false } : undefined,
			lazyConnect: true,
		});

		redis.on('error', (err) => {
			if (isConnected) {
				logger.error(`Search sync: Redis error - ${err.message}`);
				isConnected = false;
			}
		});

		redis.on('connect', () => {
			isConnected = true;
			logger.info('Search sync: Redis connected successfully');
		});

		redis.on('close', () => {
			isConnected = false;
		});

		// Try to connect but don't block startup
		redis.connect().catch((err) => {
			logger.warn(`Search sync: Could not connect to Redis - ${err.message}`);
			redis = null;
		});
	} catch (err) {
		logger.warn(`Search sync: Failed to initialize Redis - ${err}`);
		return;
	}

	/**
	 * Publish sync event to Redis stream
	 */
	async function publishEvent(
		eventAction: 'upsert' | 'delete',
		collection: string,
		ids: string[]
	): Promise<void> {
		if (!redis || !isConnected) return;
		if (ids.length === 0) return;

		const dealer = extractDealer(collection);
		const entityType = getEntityType(collection);

		try {
			for (const id of ids) {
				await redis.xadd(
					STREAM_NAME,
					'*',
					'action', eventAction,
					'dealer', dealer,
					'entity_type', entityType,
					'entity_id', id,
					'collection', collection,
					'timestamp', Date.now().toString()
				);
			}

			logger.debug(`Search sync: Published ${ids.length} ${eventAction} events for ${collection}`);
		} catch (err) {
			logger.error(`Search sync: Failed to publish events - ${err}`);
		}
	}

	// Hook: items.create
	action('items.create', async ({ collection, key }) => {
		if (!isSearchable(collection)) return;
		await publishEvent('upsert', collection, [String(key)]);
	});

	// Hook: items.update
	action('items.update', async ({ collection, keys }) => {
		if (!isSearchable(collection)) return;
		await publishEvent('upsert', collection, keys.map(String));
	});

	// Hook: items.delete
	action('items.delete', async ({ collection, keys }) => {
		if (!isSearchable(collection)) return;
		await publishEvent('delete', collection, keys.map(String));
	});
});
