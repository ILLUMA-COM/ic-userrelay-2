# Search Sync Hook Extension

Directus hook extension that publishes product and category changes to a Redis stream for real-time search indexing.

## How It Works

1. Listens for `items.create`, `items.update`, `items.delete` events
2. Filters to collections ending in `_products` or `_categories`
3. Publishes events to Redis stream `search:sync`
4. ic-search-engine consumes the stream and updates Meilisearch

## Event Format

```json
{
  "action": "upsert|delete",
  "dealer": "pntl",
  "entity_type": "products|categories",
  "entity_id": "uuid",
  "collection": "pntl_products",
  "timestamp": "1706500000000"
}
```

## Configuration

Add `REDIS_URL` to your Directus environment:

```env
REDIS_URL=redis://:password@localhost:6379/0
```

## Building

```bash
cd extensions/hooks/search-sync
npm install
npm run build
```

## Development

Watch mode for auto-rebuild:

```bash
npm run dev
```

## Deployment

The built `dist/index.js` is loaded by Directus on startup. Mount this extension folder to your Directus container:

```yaml
volumes:
  - ./extensions/hooks/search-sync:/directus/extensions/directus-extension-search-sync
```

Or if using the monorepo structure, ensure the extensions path is configured in Directus.
