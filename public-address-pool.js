export const PUBLIC_ADDRESS_SOURCE =
	'https://raw.githubusercontent.com/fnxa0524/dizhichi-cf-ips/main/cfnew-ipv4.txt';
export const PUBLIC_ADDRESS_CACHE_KEY = 'public-address-pool.v1.json';
export const PUBLIC_ADDRESS_UPDATE_INTERVAL_MS = 3 * 60 * 60 * 1000;

const DEFAULT_PORT = 443;
const FETCH_TIMEOUT_MS = 10_000;

class PoolUpdateError extends Error {
	constructor(code) {
		super(code);
		this.name = 'PoolUpdateError';
		this.code = code;
	}
}

function ipv4ToInteger(ip) {
	return ip.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function inCidr(ipInteger, base, prefixLength) {
	const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
	return (ipInteger & mask) === (ipv4ToInteger(base) & mask);
}

export function isPublicIPv4(ip) {
	if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
	const octets = ip.split('.').map(Number);
	if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;

	const value = ipv4ToInteger(ip);
	const blockedCidrs = [
		['0.0.0.0', 8],
		['10.0.0.0', 8],
		['100.64.0.0', 10],
		['127.0.0.0', 8],
		['169.254.0.0', 16],
		['172.16.0.0', 12],
		['192.0.0.0', 24],
		['192.0.2.0', 24],
		['192.88.99.0', 24],
		['192.168.0.0', 16],
		['198.18.0.0', 15],
		['198.51.100.0', 24],
		['203.0.113.0', 24],
		['224.0.0.0', 4],
		['240.0.0.0', 4],
	];
	return !blockedCidrs.some(([base, prefixLength]) => inCidr(value, base, prefixLength));
}

function sanitizeRegionNote(note) {
	const normalized = String(note || '')
		.normalize('NFKC')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return normalized.slice(0, 32) || '未知地区';
}

function regionCode(note) {
	const tokens = String(note || '').toUpperCase().match(/[A-Z]{2,3}/g) || [];
	// 小号上游备注形如 CF4-HK-...；CF 是来源前缀，地区码在下一段。
	const regions = new Set([
		'HK', 'JP', 'SG', 'US', 'KR', 'TW', 'TH', 'MY', 'PH', 'VN', 'ID',
		'GB', 'DE', 'FR', 'NL', 'CA', 'AU', 'IN', 'BR', 'RU', 'AE',
	]);
	return tokens.find(token => regions.has(token)) || tokens.find(token => token !== 'CF') || 'ZZ';
}

export function parsePublicAddressPool(text) {
	const unique = new Map();
	let rawCount = 0;
	let invalidCount = 0;
	let duplicateCount = 0;
	let upstreamUpdatedAt = null;

	for (const originalLine of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = originalLine.trim();
		if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;
		const headerMatch = line.match(/^bestips\s+updated\s+at#(.+)$/i);
		if (headerMatch) {
			upstreamUpdatedAt = headerMatch[1].trim().slice(0, 32) || null;
			continue;
		}

		rawCount += 1;
		const match = line.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:#(.*))?$/);
		if (!match) {
			invalidCount += 1;
			continue;
		}

		const server = match[1];
		const port = match[2] ? Number(match[2]) : DEFAULT_PORT;
		if (!isPublicIPv4(server) || !Number.isInteger(port) || port < 1 || port > 65535) {
			invalidCount += 1;
			continue;
		}

		const key = `${server}:${port}`;
		if (unique.has(key)) {
			duplicateCount += 1;
			continue;
		}

		const regionNote = sanitizeRegionNote(match[3]);
		unique.set(key, {
			server,
			port,
			region: regionCode(regionNote),
			regionNote,
		});
	}

	const entries = Array.from(unique.values()).sort((left, right) =>
		ipv4ToInteger(left.server) - ipv4ToInteger(right.server)
		|| left.port - right.port
		|| left.region.localeCompare(right.region)
	);
	const regionCounters = new Map();
	for (const entry of entries) {
		const next = (regionCounters.get(entry.region) || 0) + 1;
		regionCounters.set(entry.region, next);
		entry.name = `[池]${entry.region}-${String(next).padStart(3, '0')}`;
	}

	return {
		rawCount,
		invalidCount,
		duplicateCount,
		uniqueCount: entries.length,
		upstreamUpdatedAt,
		entries,
	};
}

function isUsableCache(cache) {
	return Boolean(
		cache
		&& cache.version === 1
		&& Number.isFinite(Date.parse(cache.updatedAt))
		&& Array.isArray(cache.entries)
		&& cache.entries.length > 0
		&& cache.uniqueCount === cache.entries.length
	);
}

function sanitizedError(error) {
	if (error instanceof PoolUpdateError) return error.code;
	if (error?.name === 'AbortError') return 'upstream_timeout';
	return 'pool_update_failed';
}

function logUpdate({ status, parsed, replaced = false, error = null }) {
	console.log(JSON.stringify({
		time: new Date().toISOString(),
		status,
		raw: parsed?.rawCount || 0,
		invalid: parsed?.invalidCount || 0,
		unique: parsed?.uniqueCount || 0,
		replaced,
		error: error ? sanitizedError(error) : null,
	}));
}

async function readCache(kv) {
	if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
		throw new PoolUpdateError('kv_binding_missing');
	}
	try {
		const raw = await kv.get(PUBLIC_ADDRESS_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return isUsableCache(parsed) ? parsed : null;
	} catch {
		throw new PoolUpdateError('kv_read_failed');
	}
}

async function fetchSource(fetchImpl) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetchImpl(PUBLIC_ADDRESS_SOURCE, {
			signal: controller.signal,
			headers: {
				Accept: 'text/plain',
				'User-Agent': 'edgetunnel-public-address-pool/1.0',
			},
		});
		if (!response.ok) throw new PoolUpdateError(`upstream_http_${response.status}`);
		return await response.text();
	} finally {
		clearTimeout(timeout);
	}
}

export async function loadPublicAddressPool(env, options = {}) {
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const fetchImpl = options.fetchImpl || fetch;
	let current = null;
	try {
		current = await readCache(env?.KV);
	} catch (error) {
		logUpdate({ status: 'cache_read_failed', error });
		throw error;
	}

	if (
		current
		&& !options.force
		&& now - Date.parse(current.updatedAt) < PUBLIC_ADDRESS_UPDATE_INTERVAL_MS
	) {
		return { ...current, runtimeStatus: 'cache_fresh', fromCache: true };
	}

	let parsed;
	try {
		parsed = parsePublicAddressPool(await fetchSource(fetchImpl));
		if (parsed.uniqueCount === 0) throw new PoolUpdateError('upstream_empty');
		if (current && parsed.uniqueCount < current.uniqueCount * 0.3) {
			throw new PoolUpdateError('upstream_below_30_percent');
		}

		const next = {
			version: 1,
			source: PUBLIC_ADDRESS_SOURCE,
			updatedAt: new Date(now).toISOString(),
			upstreamUpdatedAt: parsed.upstreamUpdatedAt,
			rawCount: parsed.rawCount,
			invalidCount: parsed.invalidCount,
			duplicateCount: parsed.duplicateCount,
			uniqueCount: parsed.uniqueCount,
			entries: parsed.entries,
		};
		try {
			await env.KV.put(PUBLIC_ADDRESS_CACHE_KEY, JSON.stringify(next));
		} catch {
			throw new PoolUpdateError('kv_write_failed');
		}
		logUpdate({ status: 'updated', parsed, replaced: Boolean(current) });
		return { ...next, runtimeStatus: 'updated', fromCache: false };
	} catch (error) {
		if (current) {
			logUpdate({ status: 'retained_last_success', parsed, error });
			return {
				...current,
				runtimeStatus: 'retained_last_success',
				fromCache: true,
				updateError: sanitizedError(error),
			};
		}
		logUpdate({ status: 'unavailable', parsed, error });
		throw error;
	}
}

export function publicAddressPoolMetadata(pool) {
	return {
		available: isUsableCache(pool),
		source: PUBLIC_ADDRESS_SOURCE,
		updateIntervalHours: PUBLIC_ADDRESS_UPDATE_INTERVAL_MS / 3_600_000,
		updatedAt: pool?.updatedAt || null,
		upstreamUpdatedAt: pool?.upstreamUpdatedAt || null,
		rawCount: pool?.rawCount || 0,
		invalidCount: pool?.invalidCount || 0,
		duplicateCount: pool?.duplicateCount || 0,
		uniqueCount: pool?.uniqueCount || 0,
		status: pool?.runtimeStatus || (isUsableCache(pool) ? 'cache_available' : 'unavailable'),
		retainedLastSuccess: pool?.runtimeStatus === 'retained_last_success',
		error: pool?.updateError || null,
	};
}

export async function readPublicAddressPoolStatus(env) {
	try {
		const pool = await readCache(env?.KV);
		return publicAddressPoolMetadata(pool);
	} catch (error) {
		return {
			...publicAddressPoolMetadata(null),
			status: 'cache_read_failed',
			error: sanitizedError(error),
		};
	}
}
