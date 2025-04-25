export interface Env {
	KV: KVNamespace;
	DB: D1Database;
	ADMIN_SECRET_KEY: string;
}

export interface Country {
	iso: string;
	iso3: string;
	isoNumeric: string;
	fips: string;
	country: string;
	capital: string;
	area: number;
	population: number;
	continent: string;
	tld: string;
	currencyCode: string;
	currencyName: string;
	phone: string;
	postalCodeFormat: string;
	postalCodeRegex: string;
	languages: string;
	geonameId: number;
	neighbours: string;
	equivalentFipsCode: string;
}

export interface City {
	geonameid: number;
	name: string;
	asciiname: string;
	alternatenames: string;
	latitude: number;
	longitude: number;
	featureClass: string;
	featureCode: string;
	countryCode: string;
	cc2: string;
	admin1Code: string;
	admin2Code: string;
	admin3Code: string;
	admin4Code: string;
	population: number;
	elevation: number;
	dem: number;
	timezone: string;
	modificationDate: string;
}

export interface ImportState {
	status: 'not_started' | 'in_progress' | 'completed' | 'failed';
	cityFileName: string;
	processedLines: number;
	processedCities: number;
	skippedCities: number;
	totalLines?: number;
	startedAt: string;
	lastUpdatedAt: string;
	completedAt?: string;
	error?: string;
	errors?: string[];
	failedOffsets?: number[];
	options: {
		cityPopulationThreshold: number;
		includeAlternateNames: boolean;
		offset: number;
		limit: number;
	};
} 