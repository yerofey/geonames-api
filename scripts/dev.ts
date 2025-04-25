// @ts-ignore: Bun type declarations are not installed locally
import { serve } from 'bun';
import { app } from '../src/index';

// Mock environment for local development
const env = {
	KV: {
		async get(key: string) {
			console.log(`[KV] Getting key: ${key}`);
			return null;
		},
		async put(key: string, value: string) {
			console.log(`[KV] Putting key: ${key}`);
		},
	},
	DB: {
		async prepare(query: string) {
			console.log(`[DB] Preparing query: ${query}`);
			return {
				bind(...args: any[]) {
					console.log(`[DB] Binding args:`, args);
					return this;
				},
				async all() {
					console.log(`[DB] Executing query`);
					return { results: [] };
				},
				async run() {
					console.log(`[DB] Running query`);
				},
			};
		},
	},
};

// Start the server
serve({
  async fetch(request: Request) {
    return app.fetch(request, env);
  },
  port: 3000,
});

console.log('Server running at http://localhost:3000'); 