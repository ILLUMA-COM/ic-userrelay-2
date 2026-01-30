import { defineHook } from '@directus/extensions-sdk';
import Redis from 'ioredis';

const STREAM_NAME = 'search:sync';

// Collections that should trigger search sync
const SEARCHABLE_SUFFIXES = ['_products', '_categories'];

function isSearchable(collection: string): boolean {
	return SEARCHABLE_SUFFIXES.some((suffix) => collection.endsWith(suffix));
}

function extractDealer(collection: string): string {
	for (const suffix of SEARCHABLE_SUFFIXES) {
		if (collection.endsWith(suffix)) {
			return collection.slice(0, -suffix.length);
		}
	}
	return collection;
}

function getEntityType(collection: string): string {
	for (const suffix of SEARCHABLE_SUFFIXES) {
		if (collection.endsWith(suffix)) {
			return suffix.slice(1);
		}
	}
	return 'unknown';
}

export default defineHook(({ action }, { env, logger }) => {
	let redis: Redis | null = null;
	let isConnected = false;

	// Use REDIS (same as Directus core)
	const redisUrl = env['REDIS'];
	
	if (!redisUrl) {
		logger.warn('Search sync: REDIS not configured - extension disabled');
		return;
	}

	logger.info('Search sync: Connecting to Redis...');

	try {
		const isTLS = redisUrl.startsWith('rediss://');
		
		redis = new Redis(redisUrl, {
			maxRetriesPerRequest: 3,
			retryStrategy(times) {
				if (times > 5) {
					logger.warn('Search sync: Redis connection failed - disabling');
					return null;
				}
				return Math.min(times * 200, 2000);
			},
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
			logger.info('Search sync: Redis connected');
		});

		redis.on('close', () => {
			isConnected = false;
		});

		redis.connect().catch((err) => {
			logger.warn(`Search sync: Redis connect failed - ${err.message}`);
			redis = null;
		});
	} catch (err) {
		logger.warn(`Search sync: Init failed - ${err}`);
		return;
	}

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
			logger.debug(`Search sync: Published ${ids.length} ${eventAction} for ${collection}`);
		} catch (err) {
			logger.error(`Search sync: Publish failed - ${err}`);
		}
	}

	action('items.create', async ({ collection, key }) => {
		if (!isSearchable(collection)) return;
		await publishEvent('upsert', collection, [String(key)]);
	});

	action('items.update', async ({ collection, keys }) => {
		if (!isSearchable(collection)) return;
		await publishEvent('upsert', collection, keys.map(String));
	});

	action('items.delete', async ({ collection, keys }) => {
		if (!isSearchable(collection)) return;
		await publishEvent('delete', collection, keys.map(String));
	});
});
