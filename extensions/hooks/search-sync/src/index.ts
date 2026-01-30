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

	// Initialize Redis connection
	const redisUrl = env['REDIS_URL'] as string | undefined;
	
	if (!redisUrl) {
		logger.warn('REDIS_URL not configured - search sync disabled');
		return;
	}

	try {
		redis = new Redis(redisUrl, {
			maxRetriesPerRequest: 3,
			retryDelayOnFailover: 100,
			lazyConnect: true,
		});

		redis.on('error', (err) => {
			logger.error(`Redis connection error: ${err.message}`);
		});

		redis.on('connect', () => {
			logger.info('Search sync: Redis connected');
		});

		// Connect immediately
		redis.connect().catch((err) => {
			logger.error(`Failed to connect to Redis: ${err.message}`);
		});
	} catch (err) {
		logger.error(`Failed to initialize Redis: ${err}`);
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
		if (!redis) return;
		if (ids.length === 0) return;

		const dealer = extractDealer(collection);
		const entityType = getEntityType(collection);

		try {
			for (const id of ids) {
				await redis.xadd(
					STREAM_NAME,
					'*', // Auto-generate ID
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
