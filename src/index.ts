/**
 * Welcome to Cloudflare Workers!
 *
 * This is a template for a Scheduled Worker: a Worker that can run on a
 * configurable interval:
 * https://developers.cloudflare.com/workers/platform/triggers/cron-triggers/
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Run `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` to see your Worker in action
 * - Run `npm run deploy` to publish your Worker
 *
 * Bind resources to your Worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run generate-types`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { Context } from 'hono';
import { Env, ImportState } from './types';
import JSZip from 'jszip';

export const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', cors());

// Utility function for error responses
function errorResponse(error: string, status = 500) {
	return {
		status: 'error',
		error,
		total: 0,
		results: [],
		timestamp: new Date().toISOString()
	};
}

// Utility function for success responses
function successResponse(data: any) {
	return {
		status: 'ok',
		...data,
		timestamp: new Date().toISOString()
	};
}

// Utility function to validate pagination parameters
function validatePagination(limit?: string, offset?: string) {
	const parsedLimit = limit ? parseInt(limit) : 1000;
	const parsedOffset = offset ? parseInt(offset) : 0;

	if (isNaN(parsedLimit) || parsedLimit < 1) {
		throw new Error('Invalid limit parameter. Must be a positive number.');
	}
	if (isNaN(parsedOffset) || parsedOffset < 0) {
		throw new Error('Invalid offset parameter. Must be a non-negative number.');
	}

	return { limit: parsedLimit, offset: parsedOffset };
}

// Utility function to validate authentication
async function validateAuth(c: Context) {
	const authHeader = c.req.header('Authorization');
		
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		throw new Error('Authorization header with Bearer token is required');
	}
	
	const token = authHeader.split(' ')[1];
	if (token !== c.env.ADMIN_SECRET_KEY) {
		throw new Error('Invalid authorization token');
	}
}

// Health check endpoint
app.get('/', (c) => {
	return c.json(successResponse({
		message: 'GeoNames API is running'
	}));
});

// Manual trigger endpoint for scraping
app.post('/trigger-scrape', async (c) => {
	try {
		await validateAuth(c);

		// Parse and validate options from request body
		const options = await c.req.json().catch(() => ({}));
		
		if (options.cityPopulationThreshold && (
			isNaN(options.cityPopulationThreshold) || 
			options.cityPopulationThreshold < 0
		)) {
			return c.json(errorResponse('Invalid population threshold'), 400);
		}

		if (options.limit && (
			isNaN(options.limit) || 
			options.limit < 1 || 
			options.limit > 1000
		)) {
			return c.json(errorResponse('Invalid limit. Must be between 1 and 1000'), 400);
		}

		if (options.offset && (
			isNaN(options.offset) || 
			options.offset < 0
		)) {
			return c.json(errorResponse('Invalid offset. Must be non-negative'), 400);
		}
		
		// Start scraping in the background
		c.executionCtx.waitUntil(scrapeAndStoreGeoNamesData(c.env, options));

		return c.json(successResponse({
			message: 'Import started',
			data: { options }
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to start import';
		const status = message.includes('Authorization') ? 401 : 500;
		return c.json(errorResponse(message, status), status);
	}
});

// Countries endpoint
app.get('/countries', async (c) => {
	try {
		const countries = await c.env.KV.get('countries');
		if (!countries) {
			return c.json(errorResponse('No countries data available. Please trigger scraping first.'), 404);
		}

		const parsedCountries = JSON.parse(countries);
		return c.json(successResponse({
			total: parsedCountries.length,
			results: parsedCountries
		}));
	} catch (error) {
		return c.json(errorResponse('Failed to fetch countries'), 500);
	}
});

// Cities endpoint
app.get('/cities', async (c) => {
	try {
		// Validate pagination parameters
		const { limit, offset } = validatePagination(
			c.req.query('limit'),
			c.req.query('offset')
		);

		const countryCode = c.req.query('country')?.toUpperCase();
		
		let whereClause = '';
		const params: any[] = [];
		
		if (countryCode) {
			// Validate country code format
			if (!/^[A-Z]{2}$/.test(countryCode)) {
				return c.json(errorResponse('Invalid country code format. Must be 2 letters.'), 400);
			}
			whereClause = ' WHERE countryCode = ?';
			params.push(countryCode);
		}
		
		// Get total count
		const countQuery = `SELECT COUNT(*) as total FROM cities${whereClause}`;
		const totalCount = await c.env.DB.prepare(countQuery)
			.bind(...params)
			.first();
		
		const total = totalCount?.total ? Number(totalCount.total) : 0;

		// If no results, return early
		if (total === 0) {
			return c.json(successResponse({
				total: 0,
				results: [],
				pagination: { limit, offset, hasMore: false }
			}));
		}

		// Get paginated results
		const query = `SELECT * FROM cities${whereClause} ORDER BY population DESC LIMIT ? OFFSET ?`;
		params.push(limit, offset);
		
		const cities = await c.env.DB.prepare(query)
			.bind(...params)
			.all();
			
		return c.json(successResponse({
			total,
			results: cities.results || [],
			pagination: {
				limit,
				offset,
				hasMore: (offset + limit) < total
			}
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to fetch cities';
		const status = message.includes('Invalid') ? 400 : 500;
		return c.json(errorResponse(message, status), status);
	}
});

// Add cities count endpoint
app.get('/cities/count', async (c) => {
	try {
		await validateAuth(c);

		const result = await c.env.DB.prepare('SELECT COUNT(*) as count FROM cities').first();
		
		// Also get counts by population threshold
		const thresholdCounts = await c.env.DB.prepare(`
			SELECT 
				COUNT(*) as total,
				SUM(CASE WHEN population >= 15000 THEN 1 ELSE 0 END) as above_15k,
				SUM(CASE WHEN population >= 5000 THEN 1 ELSE 0 END) as above_5k,
				SUM(CASE WHEN population >= 1000 THEN 1 ELSE 0 END) as above_1k
			FROM cities
		`).first();

		return c.json(successResponse({
			data: {
				count: result?.count || 0,
				thresholds: {
					above_15k: thresholdCounts?.above_15k || 0,
					above_5k: thresholdCounts?.above_5k || 0,
					above_1k: thresholdCounts?.above_1k || 0
				}
			}
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to get cities count';
		const status = message.includes('Authorization') ? 401 : 500;
		return c.json(errorResponse(message, status), status);
	}
});

// Search endpoint
app.get('/search', async (c) => {
	try {
		const query = c.req.query('q');
		if (!query || query.length < 2) {
			return c.json(errorResponse('Search query must be at least 2 characters long'), 400);
		}

		// Validate pagination parameters
		const { limit, offset } = validatePagination(
			c.req.query('limit'),
			c.req.query('offset')
		);

		// Get total count first
		const countResult = await c.env.DB.prepare(
			'SELECT COUNT(*) as total FROM cities WHERE name LIKE ? OR alternatenames LIKE ?'
		)
			.bind(`%${query}%`, `%${query}%`)
			.first();

		const total = countResult?.total ? Number(countResult.total) : 0;

		// If no results, return early
		if (total === 0) {
			return c.json(successResponse({
				total: 0,
				results: [],
				pagination: { limit, offset, hasMore: false }
			}));
		}

		// Get paginated results
		const results = await c.env.DB.prepare(
			'SELECT * FROM cities WHERE name LIKE ? OR alternatenames LIKE ? ORDER BY population DESC LIMIT ? OFFSET ?'
		)
			.bind(`%${query}%`, `%${query}%`, limit, offset)
			.all();
			
		return c.json(successResponse({
			total,
			results: results.results || [],
			pagination: {
				limit,
				offset,
				hasMore: (offset + limit) < total
			}
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Search failed';
		const status = message.includes('Invalid') ? 400 : 500;
		return c.json(errorResponse(message, status), status);
	}
});

// Add country-related endpoints
app.get('/countries/search', async (c) => {
	try {
		const query = c.req.query('q');
		if (!query || query.length < 2) {
			return c.json(errorResponse('Search query must be at least 2 characters long'), 400);
		}

		// Get total count first
		const countResult = await c.env.DB.prepare(
			'SELECT COUNT(*) as total FROM countries WHERE country LIKE ? OR capital LIKE ?'
		)
			.bind(`%${query}%`, `%${query}%`)
			.first();

		const total = countResult?.total ? Number(countResult.total) : 0;

		const results = await c.env.DB.prepare(
			'SELECT * FROM countries WHERE country LIKE ? OR capital LIKE ? ORDER BY population DESC'
		)
			.bind(`%${query}%`, `%${query}%`)
			.all();

		return c.json(successResponse({
			total,
			results: results.results || []
		}));
	} catch (error) {
		return c.json(errorResponse('Search failed'), 500);
	}
});

// Country by code endpoint
app.get('/countries/:code', async (c) => {
	try {
		const code = c.req.param('code').toUpperCase();
		
		// Validate country code format
		if (!/^[A-Z]{2}$/.test(code)) {
			return c.json(errorResponse('Invalid country code format. Must be 2 letters.'), 400);
		}

		const country = await c.env.DB.prepare(
			'SELECT * FROM countries WHERE iso = ?'
		)
			.bind(code)
			.first();

		if (!country) {
			return c.json(errorResponse('Country not found'), 404);
		}

		return c.json(successResponse({ data: country }));
	} catch (error) {
		return c.json(errorResponse('Failed to fetch country'), 500);
	}
});

// Add new endpoint to check import status
app.get('/import-status', async (c) => {
	try {
		await validateAuth(c);

		const state = await c.env.KV.get('import_state', 'json') as ImportState;
		return c.json(successResponse({
			data: state || { status: 'not_started' }
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to get import status';
		const status = message.includes('Authorization') ? 401 : 500;
		return c.json(errorResponse(message, status), status);
	}
});

// Add utility functions for timezone conversion
function timezoneToUrl(timezone: string): string {
	return timezone.replace(/\//g, '__');
}

function urlToTimezone(url: string): string {
	return url.replace(/__/g, '/');
}

// Add timezones endpoint
app.get('/timezones', async (c) => {
	try {
		// Get unique timezones with their count
		const timezones = await c.env.DB.prepare(`
			SELECT 
				timezone,
				COUNT(*) as city_count,
				MIN(population) as min_population,
				MAX(population) as max_population,
				ROUND(AVG(population)) as avg_population
			FROM cities 
			WHERE timezone IS NOT NULL 
			GROUP BY timezone 
			ORDER BY city_count DESC
		`).all();

		// Convert timezone names to URL-safe format
		const results = timezones.results?.map(tz => {
			if (typeof tz.timezone !== 'string') {
				throw new Error('Invalid timezone format');
			}
			return {
				...tz,
				timezone_url: timezoneToUrl(tz.timezone)
			};
		}) || [];

		return c.json(successResponse({
			total: results.length,
			results
		}));
	} catch (error) {
		return c.json(errorResponse('Failed to fetch timezones'), 500);
	}
});

// Add timezone details endpoint
app.get('/timezones/:timezone_url', async (c) => {
	try {
		const timezoneUrl = c.req.param('timezone_url');
		const timezone = urlToTimezone(timezoneUrl);
		
		// Get cities in this timezone
		const cities = await c.env.DB.prepare(`
			SELECT 
				geonameid,
				name,
				countryCode,
				population,
				latitude,
				longitude
			FROM cities 
			WHERE timezone = ?
			ORDER BY population DESC
			LIMIT 100
		`).bind(timezone).all();

		// Get timezone statistics
		const stats = await c.env.DB.prepare(`
			SELECT 
				COUNT(*) as total_cities,
				SUM(population) as total_population,
				MIN(population) as min_population,
				MAX(population) as max_population,
				ROUND(AVG(population)) as avg_population
			FROM cities 
			WHERE timezone = ?
		`).bind(timezone).first();

		return c.json(successResponse({
			timezone,
			timezone_url: timezoneUrl,
			statistics: stats,
			cities: cities.results || []
		}));
	} catch (error) {
		return c.json(errorResponse('Failed to fetch timezone details'), 500);
	}
});

// Scheduled handler for cron job
async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
	console.log(`[${new Date().toISOString()}] Cron job started: ${event.cron}`);
	
	// Get current import state
	const currentState = await env.KV.get('import_state', 'json') as ImportState;
	
	// If there are failed offsets from previous run, retry them first
	if (currentState?.failedOffsets && currentState.failedOffsets.length > 0) {
		console.log(`Retrying ${currentState.failedOffsets.length} failed offsets from previous run`);
		for (const offset of currentState.failedOffsets) {
			ctx.waitUntil(scrapeAndStoreGeoNamesData(env, {
				offset,
				limit: 50,
				cityPopulationThreshold: currentState.options?.cityPopulationThreshold || 15000
			}));
		}
	}
	
	// Start new import with default options
	ctx.waitUntil(scrapeAndStoreGeoNamesData(env, {
		cityPopulationThreshold: 15000,
		limit: 50,
		offset: 0,
		cleanStart: false
	}));
}

// Scrape and store GeoNames data
export async function scrapeAndStoreGeoNamesData(
	env: Env,
	options: {
		cityPopulationThreshold?: number;
		includeAlternateNames?: boolean;
		offset?: number;
		limit?: number;
		cleanStart?: boolean;
	} = {}
): Promise<void> {
	const {
		cityPopulationThreshold = 15000,
		includeAlternateNames = false,
		offset = 0,
		limit = 50,
		cleanStart = false
	} = options;

	try {
		// Determine which city file to download
		let cityFileName: string;
		if (cityPopulationThreshold >= 15000) {
			cityFileName = 'cities15000.zip';
		} else if (cityPopulationThreshold >= 5000) {
			cityFileName = 'cities5000.zip';
		} else if (cityPopulationThreshold >= 1000) {
			cityFileName = 'cities1000.zip';
		} else {
			cityFileName = 'allCountries.zip';
		}

		// Initialize or update import state
		let state: ImportState;
		const existingState = await env.KV.get('import_state', 'json') as ImportState;

		if (cleanStart || !existingState) {
			state = {
				status: 'in_progress',
				cityFileName,
				processedLines: 0,
				processedCities: 0,
				skippedCities: 0,
				failedOffsets: [],
				startedAt: new Date().toISOString(),
				lastUpdatedAt: new Date().toISOString(),
				options: {
					cityPopulationThreshold,
					includeAlternateNames,
					offset,
					limit
				}
			};

			// If clean start, clear existing data
			if (cleanStart) {
				console.log(`[${new Date().toISOString()}] Clean start requested, clearing existing data`);
				await env.DB.prepare('DELETE FROM cities').run();
			}

			// Create tables and import countries
			await createTablesAndIndexes(env);
			await importCountries(env);
		} else {
			state = existingState;
			
			// Update options if they've changed
			state.options = {
				...state.options,
				cityPopulationThreshold,
				includeAlternateNames,
				offset,
				limit
			};
		}

		// Download and process cities
		console.log(`[${new Date().toISOString()}] Processing cities from offset ${offset}, limit ${limit}, threshold ${cityPopulationThreshold}`);
		const citiesResponse = await fetch(`http://download.geonames.org/export/dump/${cityFileName}`);
		if (!citiesResponse.ok) {
			throw new Error(`Failed to fetch cities: ${citiesResponse.status}`);
		}

		const citiesZipBuffer = await citiesResponse.arrayBuffer();
		const zip = new JSZip();
		await zip.loadAsync(citiesZipBuffer);
		
		const citiesFile = zip.file(cityFileName.replace('.zip', '.txt'));
		if (!citiesFile) {
			throw new Error('Cities file not found in ZIP archive');
		}
		
		const citiesText = await citiesFile.async('text');
		const lines = citiesText.split('\n').filter(line => line.trim());

		if (!state.totalLines) {
			state.totalLines = lines.length;
		}

		// Process the specified batch
		const batch = lines.slice(offset, offset + limit);
		console.log(`[${new Date().toISOString()}] Processing ${batch.length} lines from ${cityFileName}`);

		let batchSuccessful = true;
		const errors: string[] = [];

		// Process each city in the batch
		for (const line of batch) {
			try {
				const [
					geonameid, name, asciiname, alternatenames, latitude, longitude,
					featureClass, featureCode, countryCode, cc2, admin1Code, admin2Code,
					admin3Code, admin4Code, population, elevation, dem, timezone, modificationDate
				] = line.split('\t');

				const pop = parseInt(population);
				if (pop < cityPopulationThreshold) {
					state.skippedCities++;
					continue;
				}

				await env.DB.prepare(`
					INSERT OR REPLACE INTO cities (
						geonameid, name, asciiname, alternatenames, latitude, longitude,
						featureClass, featureCode, countryCode, cc2, admin1Code, admin2Code,
						admin3Code, admin4Code, population, elevation, dem, timezone, modificationDate
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
					.bind(
						parseInt(geonameid), name, asciiname, alternatenames,
						parseFloat(latitude), parseFloat(longitude),
						featureClass, featureCode, countryCode, cc2,
						admin1Code, admin2Code, admin3Code, admin4Code,
						pop, parseInt(elevation), parseInt(dem),
						timezone, modificationDate
					)
					.run();

				state.processedCities++;
			} catch (error) {
				batchSuccessful = false;
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}

		// Update state
		state.processedLines += batch.length;
		state.lastUpdatedAt = new Date().toISOString();

		// Track failed offset if batch wasn't successful
		if (!batchSuccessful) {
			if (!state.failedOffsets) {
				state.failedOffsets = [];
			}
			state.failedOffsets.push(offset);
			state.errors = errors;
		}

		// Check if this was the last batch
		if (offset + limit >= state.totalLines) {
			state.status = state.failedOffsets?.length ? 'failed' : 'completed';
			state.completedAt = new Date().toISOString();
		}

		await env.KV.put('import_state', JSON.stringify(state));

		console.log(`[${new Date().toISOString()}] Batch complete. Processed ${state.processedCities} cities, skipped ${state.skippedCities}, failed offsets: ${state.failedOffsets?.length || 0}`);

	} catch (error) {
		// Update state with error
		const errorState: ImportState = {
			...(await env.KV.get('import_state', 'json') as ImportState || {}),
			status: 'failed',
			error: error instanceof Error ? error.message : String(error),
			lastUpdatedAt: new Date().toISOString()
		};
		await env.KV.put('import_state', JSON.stringify(errorState));
		throw error;
	}
}

async function createTablesAndIndexes(env: Env): Promise<void> {
	// Create countries table
	await env.DB.prepare(`
		CREATE TABLE IF NOT EXISTS countries (
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
	`).run();

	// Create indexes for countries
	await env.DB.prepare(`
		CREATE INDEX IF NOT EXISTS idx_countries_iso ON countries(iso);
		CREATE INDEX IF NOT EXISTS idx_countries_name ON countries(country);
		CREATE INDEX IF NOT EXISTS idx_countries_capital ON countries(capital);
		CREATE INDEX IF NOT EXISTS idx_countries_continent ON countries(continent);
	`).run();

	// Create cities table
	await env.DB.prepare(`
		CREATE TABLE IF NOT EXISTS cities (
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
	`).run();

	// Create indexes for cities
	await env.DB.prepare(`
		CREATE INDEX IF NOT EXISTS idx_cities_name ON cities(name);
		CREATE INDEX IF NOT EXISTS idx_cities_country ON cities(countryCode);
		CREATE INDEX IF NOT EXISTS idx_cities_alternatenames ON cities(alternatenames);
		CREATE INDEX IF NOT EXISTS idx_cities_population ON cities(population);
		CREATE INDEX IF NOT EXISTS idx_cities_timezone ON cities(timezone);
	`).run();
}

async function importCountries(env: Env): Promise<void> {
	console.log(`[${new Date().toISOString()}] Importing countries...`);
	
	const countriesResponse = await fetch('http://download.geonames.org/export/dump/countryInfo.txt');
	if (!countriesResponse.ok) {
		throw new Error(`Failed to fetch countries: ${countriesResponse.status}`);
	}
	const countriesText = await countriesResponse.text();
	
	const countries = countriesText
		.split('\n')
		.filter(line => line && !line.startsWith('#'))
		.map(line => {
			const [
				iso, iso3, isoNumeric, fips, country, capital, area, population,
				continent, tld, currencyCode, currencyName, phone, postalCodeFormat,
				postalCodeRegex, languages, geonameId, neighbours, equivalentFipsCode
			] = line.split('\t');
			
			return {
				iso,
				iso3,
				isoNumeric,
				fips,
				country,
				capital,
				area: parseFloat(area),
				population: parseInt(population),
				continent,
				tld,
				currencyCode,
				currencyName,
				phone,
				postalCodeFormat,
				postalCodeRegex,
				languages,
				geonameId: parseInt(geonameId),
				neighbours,
				equivalentFipsCode
			};
		});

	// Clear existing countries data
	await env.DB.prepare('DELETE FROM countries').run();
	
	// Store countries in both KV and D1
	await env.KV.put('countries', JSON.stringify(countries));
	
	// Insert countries into D1
	for (const country of countries) {
		await env.DB.prepare(`
			INSERT INTO countries (
				geonameId, iso, iso3, isoNumeric, fips, country, capital,
				area, population, continent, tld, currencyCode, currencyName,
				phone, postalCodeFormat, postalCodeRegex, languages,
				neighbours, equivalentFipsCode
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
			.bind(
				country.geonameId, country.iso, country.iso3, country.isoNumeric,
				country.fips, country.country, country.capital, country.area,
				country.population, country.continent, country.tld,
				country.currencyCode, country.currencyName, country.phone,
				country.postalCodeFormat, country.postalCodeRegex,
				country.languages, country.neighbours, country.equivalentFipsCode
			)
			.run();
	}
	console.log(`[${new Date().toISOString()}] Imported ${countries.length} countries`);
}

export default {
	fetch: app.fetch,
	scheduled,
};
