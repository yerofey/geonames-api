# GeoNames API

A Cloudflare Worker service that provides access to GeoNames geographical data. This service downloads data from GeoNames.org, processes it, and provides a clean API for accessing country and city information.

## Features

- **Data Sources**: Downloads and processes data from GeoNames.org
  - Countries data from `countryInfo.txt`
  - Cities data from various population thresholds:
    - `cities15000.zip` (cities with population > 15,000)
    - `cities5000.zip` (cities with population > 5,000)
    - `cities1000.zip` (cities with population > 1,000)
    - `allCountries.zip` (all cities, use with caution)

- **Storage**:
  - Countries stored in both KV and D1 for optimal access
  - Cities stored in D1 with proper indexing
  - Efficient batch processing for large datasets

## API Response Format

All API endpoints follow a consistent response format:

```typescript
{
  // Common fields
  status: 'ok' | 'error',  // Response status
  error?: string,          // Error message if status is 'error'
  timestamp?: string,      // ISO timestamp for certain endpoints

  // For list endpoints
  total?: number,          // Total count of items
  results?: any[],         // Array of items

  // For single item endpoints
  data?: any,              // Single item data

  // For paginated endpoints
  pagination?: {
    limit: number,         // Items per page
    offset: number,        // Starting offset
    hasMore: boolean       // Whether there are more items
  }
}
```

## API Endpoints

### Public Endpoints

1. **Health Check**
   ```http
   GET /
   ```
   Returns service status.
   ```json
   {
     "status": "ok",
     "message": "GeoNames API is running",
     "timestamp": "2024-03-20T12:00:00.000Z"
   }
   ```

2. **Countries List**
   ```http
   GET /countries
   ```
   Returns list of all countries with their details.
   ```json
   {
     "status": "ok",
     "total": 250,
     "results": [
       {
         "iso": "US",
         "country": "United States",
         "capital": "Washington",
         // ... other country fields
       }
     ]
   }
   ```

3. **Cities List**
   ```http
   GET /cities?country=US&limit=100&offset=0
   ```
   Returns paginated list of cities.
   - `country`: Optional country code filter
   - `limit`: Number of results per page (default: 1000)
   - `offset`: Pagination offset (default: 0)
   ```json
   {
     "status": "ok",
     "total": 1234,
     "results": [
       {
         "geonameid": 123456,
         "name": "New York",
         // ... other city fields
       }
     ],
     "pagination": {
       "limit": 100,
       "offset": 0,
       "hasMore": true
     }
   }
   ```

4. **Search Cities**
   ```http
   GET /search?q=London&limit=10&offset=0
   ```
   Search cities by name.
   - `q`: Search query
   - `limit`: Number of results (default: 10)
   - `offset`: Pagination offset (default: 0)
   ```json
   {
     "status": "ok",
     "total": 50,
     "results": [
       {
         "geonameid": 2643743,
         "name": "London",
         // ... other city fields
       }
     ],
     "pagination": {
       "limit": 10,
       "offset": 0,
       "hasMore": true
     }
   }
   ```

5. **Country Search**
   ```http
   GET /countries/search?q=United
   ```
   Search countries by name or capital.
   ```json
   {
     "status": "ok",
     "total": 5,
     "results": [
       {
         "iso": "US",
         "country": "United States",
         // ... other country fields
       }
     ]
   }
   ```

6. **Country Details**
   ```http
   GET /countries/:code
   ```
   Get detailed information about a specific country.
   ```json
   {
     "status": "ok",
     "data": {
       "iso": "US",
       "country": "United States",
       // ... other country fields
     }
   }
   ```

### Admin Endpoints (Requires Authentication)

All admin endpoints require a Bearer token in the Authorization header:
```http
Authorization: Bearer your-secret-key
```

1. **Trigger Data Import**
   ```http
   POST /trigger-scrape
   ```
   Start data import process.
   ```json
   // Request body
   {
     "cityPopulationThreshold": 5000,
     "offset": 0,
     "limit": 50,
     "cleanStart": false
   }

   // Response
   {
     "status": "ok",
     "message": "Import started",
     "data": {
       "options": {
         "cityPopulationThreshold": 5000,
         "offset": 0,
         "limit": 50,
         "cleanStart": false
       },
       "timestamp": "2024-03-20T12:00:00.000Z"
     }
   }
   ```

2. **Import Status**
   ```http
   GET /import-status
   ```
   Check current import status.
   ```json
   {
     "status": "ok",
     "data": {
       "status": "in_progress",
       "cityFileName": "cities5000.zip",
       "processedLines": 1000,
       "processedCities": 800,
       "skippedCities": 200,
       "totalLines": 10000,
       "startedAt": "2024-03-20T12:00:00.000Z",
       "lastUpdatedAt": "2024-03-20T12:01:00.000Z",
       "failedOffsets": [],
       "options": {
         "cityPopulationThreshold": 5000,
         "includeAlternateNames": false,
         "offset": 0,
         "limit": 50
       }
     }
   }
   ```

3. **Cities Count**
   ```http
   GET /cities/count
   ```
   Get total cities count and threshold statistics.
   ```json
   {
     "status": "ok",
     "data": {
       "count": 9032,
       "thresholds": {
         "above_15k": 4500,
         "above_5k": 7000,
         "above_1k": 9000
       }
     }
   }
   ```

### Error Responses

All endpoints return consistent error responses:

```json
{
  "status": "error",
  "error": "Error message description",
  "total": 0,
  "results": []
}
```

Common HTTP status codes:
- `200`: Success
- `400`: Bad Request (invalid parameters)
- `401`: Unauthorized (missing authentication)
- `403`: Forbidden (invalid authentication)
- `404`: Not Found
- `500`: Internal Server Error

## Setup and Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Bun](https://bun.sh/) for local development
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account with Workers and D1 enabled

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd geonames-api
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Create D1 database:
   ```bash
   wrangler d1 create geonames
   ```

4. Create KV namespace:
   ```bash
   wrangler kv:namespace create KV
   ```

5. Update `wrangler.toml` with your bindings:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "geonames"
   database_id = "your-d1-database-id"

   [[kv_namespaces]]
   binding = "KV"
   id = "your-kv-namespace-id"
   ```

6. Set up your admin secret:
   ```bash
   wrangler secret put ADMIN_SECRET_KEY
   ```

### Configuration

1. Copy the env file:
   ```bash
   cp .env.example .env
   ```

2. Update `.env` with your settings:
   ```bash
   # Worker URL (without trailing slash)
   WORKER_URL="https://your-worker.workers.dev"
   
   # Admin secret key for protected endpoints
   ADMIN_SECRET_KEY="your-secret-key"
   ```

### Local Development

1. Start the development server:
   ```bash
   bun run dev
   ```

2. Run tests:
   ```bash
   bun test
   ```

### Deployment

1. Deploy to Cloudflare Workers:
   ```bash
   bun run deploy
   ```

2. Import initial data:
   ```bash
   chmod +x scripts/import.sh
   ./scripts/import.sh --threshold 5000
   ```

## Data Import Process

The import process works in batches to handle large datasets efficiently:

1. Downloads country data and creates necessary database tables
2. Processes cities in configurable batches (default 50 records per batch)
3. Supports concurrent processing (default 5 parallel requests)
4. Tracks progress and handles failures gracefully
5. Provides detailed status updates

### Import Script Options

The import script (`scripts/import.sh`) supports various options for flexible data import:

```bash
# Basic usage
./scripts/import.sh

# With specific population threshold
./scripts/import.sh --threshold 15000

# Start fresh (clear existing data)
./scripts/import.sh --clean

# Retry failed imports
./scripts/import.sh --retry

# Process specific offset
./scripts/import.sh --offset 1000

# Process range of offsets
./scripts/import.sh --range 1000..2000

# Process specific offsets
./scripts/import.sh --offsets 1000,1500,2000

# Custom batch size and concurrency
./scripts/import.sh --batch-size 100 --concurrent 3
```

Available options:
- `--threshold <number>`: Set minimum city population (default: 5000)
- `--clean`: Start fresh, clearing existing data
- `--retry`: Retry previously failed imports
- `--offset <number>`: Process specific offset
- `--range <start>..<end>`: Process range of offsets
- `--offsets <list>`: Process comma-separated list of offsets
- `--batch-size <number>`: Records per batch (default: 50)
- `--concurrent <number>`: Concurrent requests (default: 5)

The import process is idempotent and supports:
- Incremental updates (default)
- Clean starts (with `--clean`)
- Automatic retry of failed batches
- Manual retry of specific failed imports
- Multiple population thresholds without data conflicts

### Troubleshooting Imports

If you notice a low number of imported cities:

1. Check the import status:
   ```bash
   curl -H "Authorization: Bearer your-secret-key" https://your-worker.workers.dev/import-status
   ```

2. Try a clean import:
   ```bash
   ./scripts/import.sh --clean --threshold 5000
   ```

3. Verify failed offsets and retry them:
   ```bash
   ./scripts/import.sh --retry
   ```

4. Check the total cities count:
   ```bash
   curl -H "Authorization: Bearer your-secret-key" https://your-worker.workers.dev/cities/count
   ```

## Database Schema

### Countries Table
```sql
CREATE TABLE countries (
    geonameId INTEGER PRIMARY KEY,
    iso TEXT UNIQUE,
    iso3 TEXT,
    isoNumeric TEXT,
    fips TEXT,
    country TEXT,
    capital TEXT,
    area REAL,
    population INTEGER,
    continent TEXT,
    tld TEXT,
    currencyCode TEXT,
    currencyName TEXT,
    phone TEXT,
    postalCodeFormat TEXT,
    postalCodeRegex TEXT,
    languages TEXT,
    neighbours TEXT,
    equivalentFipsCode TEXT
)
```

### Cities Table
```sql
CREATE TABLE cities (
    geonameid INTEGER PRIMARY KEY,
    name TEXT,
    asciiname TEXT,
    alternatenames TEXT,
    latitude REAL,
    longitude REAL,
    featureClass TEXT,
    featureCode TEXT,
    countryCode TEXT,
    cc2 TEXT,
    admin1Code TEXT,
    admin2Code TEXT,
    admin3Code TEXT,
    admin4Code TEXT,
    population INTEGER,
    elevation INTEGER,
    dem INTEGER,
    timezone TEXT,
    modificationDate TEXT,
    FOREIGN KEY(countryCode) REFERENCES countries(iso)
)
```

## Security

- All admin endpoints require Bearer token authentication
- Data import is protected by admin secret key
- Uses Cloudflare's security features by default

## Error Handling

The service includes comprehensive error handling:
- Input validation
- Rate limiting (Cloudflare's default)
- Detailed error messages
- Import process failure recovery
- Batch processing retry mechanism

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Data provided by [GeoNames.org](https://www.geonames.org/)
- Built with [Hono](https://honojs.dev/) framework
- Powered by [Cloudflare Workers](https://workers.cloudflare.com/)