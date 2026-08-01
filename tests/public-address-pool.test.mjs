import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import test from 'node:test';
import worker from '../_worker.js';
import {
	PUBLIC_ADDRESS_CACHE_KEY,
	PUBLIC_ADDRESS_UPDATE_INTERVAL_MS,
	isPublicIPv4,
	loadPublicAddressPool,
	parsePublicAddressPool,
} from '../public-address-pool.js';

function memoryKv(initial = {}) {
	const values = new Map(Object.entries(initial));
	const writes = [];
	return {
		writes,
		async get(key) {
			return values.get(key) ?? null;
		},
		async put(key, value) {
			writes.push({ key, value });
			values.set(key, value);
		},
	};
}

function sourceResponse(text, status = 200) {
	return async () => new Response(text, { status });
}

test('parses the current upstream format, deduplicates and names deterministically', () => {
	const parsed = parsePublicAddressPool([
		'bestips updated at#2026-07-26 00:39',
		'8.8.8.8:443#US',
		'1.1.1.1:443#HK',
		'8.8.8.8:443#US duplicate',
		'9.9.9.9#SG',
	].join('\n'));

	assert.equal(parsed.rawCount, 4);
	assert.equal(parsed.invalidCount, 0);
	assert.equal(parsed.duplicateCount, 1);
	assert.equal(parsed.uniqueCount, 3);
	assert.equal(parsed.upstreamUpdatedAt, '2026-07-26 00:39');
	assert.deepEqual(
		parsed.entries.map(({ server, port, name }) => ({ server, port, name })),
		[
			{ server: '1.1.1.1', port: 443, name: '[池]HK-001' },
			{ server: '8.8.8.8', port: 443, name: '[池]US-001' },
			{ server: '9.9.9.9', port: 443, name: '[池]SG-001' },
		],
	);
});

test('extracts region after CF4 source prefix', () => {
	const parsed = parsePublicAddressPool([
		'1.1.1.1:443#CF4-HK-ABC123',
		'8.8.8.8:443#CF4-JP-DEF456',
		'9.9.9.9:443#CF4-SG-GHI789',
	].join('\n'));
	assert.deepEqual(
		parsed.entries.map(({ region, name }) => ({ region, name })),
		[
			{ region: 'HK', name: '[池]HK-001' },
			{ region: 'JP', name: '[池]JP-001' },
			{ region: 'SG', name: '[池]SG-001' },
		],
	);
});

test('rejects private, loopback, link-local, multicast, reserved and invalid IPv4', () => {
	for (const ip of [
		'0.0.0.0',
		'10.0.0.1',
		'100.64.0.1',
		'127.0.0.1',
		'169.254.1.1',
		'172.16.0.1',
		'192.168.1.1',
		'198.18.0.1',
		'192.0.2.1',
		'198.51.100.1',
		'203.0.113.1',
		'224.0.0.1',
		'255.255.255.255',
		'999.1.1.1',
	]) {
		assert.equal(isPublicIPv4(ip), false, ip);
	}
	assert.equal(isPublicIPv4('1.1.1.1'), true);

	const parsed = parsePublicAddressPool([
		'10.0.0.1:443#HK',
		'1.1.1.1:0#HK',
		'1.1.1.1:65536#HK',
		'not-an-ip:443#HK',
	].join('\n'));
	assert.equal(parsed.uniqueCount, 0);
	assert.equal(parsed.invalidCount, 4);
});

test('uses one atomic cache key and keeps a fresh cache without fetching', async () => {
	const now = Date.parse('2026-07-26T03:00:00.000Z');
	const cached = {
		version: 1,
		source: 'public',
		updatedAt: new Date(now - 1_000).toISOString(),
		upstreamUpdatedAt: null,
		rawCount: 1,
		invalidCount: 0,
		duplicateCount: 0,
		uniqueCount: 1,
		entries: [{ server: '1.1.1.1', port: 443, region: 'HK', regionNote: 'HK', name: '[池]HK-001' }],
	};
	const kv = memoryKv({ [PUBLIC_ADDRESS_CACHE_KEY]: JSON.stringify(cached) });
	let fetched = false;
	const result = await loadPublicAddressPool({ KV: kv }, {
		now,
		fetchImpl: async () => {
			fetched = true;
			return new Response('8.8.8.8:443#US');
		},
	});
	assert.equal(fetched, false);
	assert.equal(result.runtimeStatus, 'cache_fresh');
	assert.equal(kv.writes.length, 0);
});

test('retains the last successful cache when refresh fails', async () => {
	const now = Date.parse('2026-07-26T06:00:00.000Z');
	const cached = {
		version: 1,
		source: 'public',
		updatedAt: new Date(now - PUBLIC_ADDRESS_UPDATE_INTERVAL_MS - 1).toISOString(),
		upstreamUpdatedAt: null,
		rawCount: 1,
		invalidCount: 0,
		duplicateCount: 0,
		uniqueCount: 1,
		entries: [{ server: '1.1.1.1', port: 443, region: 'HK', regionNote: 'HK', name: '[池]HK-001' }],
	};
	const kv = memoryKv({ [PUBLIC_ADDRESS_CACHE_KEY]: JSON.stringify(cached) });
	const result = await loadPublicAddressPool({ KV: kv }, {
		now,
		fetchImpl: sourceResponse('failure', 503),
	});
	assert.equal(result.runtimeStatus, 'retained_last_success');
	assert.equal(result.uniqueCount, 1);
	assert.equal(kv.writes.length, 0);
});

test('rejects a refresh below 30 percent of the current pool', async () => {
	const now = Date.parse('2026-07-26T09:00:00.000Z');
	const entries = Array.from({ length: 10 }, (_, index) => ({
		server: `8.8.8.${index + 1}`,
		port: 443,
		region: 'US',
		regionNote: 'US',
		name: `[池]US-${String(index + 1).padStart(3, '0')}`,
	}));
	const cached = {
		version: 1,
		source: 'public',
		updatedAt: new Date(now - PUBLIC_ADDRESS_UPDATE_INTERVAL_MS - 1).toISOString(),
		upstreamUpdatedAt: null,
		rawCount: 10,
		invalidCount: 0,
		duplicateCount: 0,
		uniqueCount: 10,
		entries,
	};
	const kv = memoryKv({ [PUBLIC_ADDRESS_CACHE_KEY]: JSON.stringify(cached) });
	const result = await loadPublicAddressPool({ KV: kv }, {
		now,
		fetchImpl: sourceResponse('1.1.1.1:443#HK\n8.8.4.4:443#US'),
	});
	assert.equal(result.runtimeStatus, 'retained_last_success');
	assert.equal(result.uniqueCount, 10);
	assert.equal(kv.writes.length, 0);
});

test('stores a valid first refresh as one complete non-empty snapshot', async () => {
	const kv = memoryKv();
	const result = await loadPublicAddressPool({ KV: kv }, {
		now: Date.parse('2026-07-26T12:00:00.000Z'),
		fetchImpl: sourceResponse('1.1.1.1:443#HK\n8.8.8.8:443#US'),
	});
	assert.equal(result.uniqueCount, 2);
	assert.equal(kv.writes.length, 1);
	assert.equal(kv.writes[0].key, PUBLIC_ADDRESS_CACHE_KEY);
	assert.equal(JSON.parse(kv.writes[0].value).entries.length, 2);
});

test('never creates an empty production cache', async () => {
	const kv = memoryKv();
	await assert.rejects(
		loadPublicAddressPool({ KV: kv }, {
			force: true,
			fetchImpl: sourceResponse('bestips updated at#2026-07-26 00:39\n10.0.0.1:443#HK'),
		}),
	);
	assert.equal(kv.writes.length, 0);
});

test('exposes read-only status and method-gated refresh routes', async () => {
	const pool = {
		version: 1,
		source: 'public',
		updatedAt: new Date().toISOString(),
		upstreamUpdatedAt: null,
		rawCount: 1,
		invalidCount: 0,
		duplicateCount: 0,
		uniqueCount: 1,
		entries: [{ server: '1.1.1.1', port: 443, region: 'HK', regionNote: 'HK', name: '[池]HK-001' }],
	};
	const kv = memoryKv({ [PUBLIC_ADDRESS_CACHE_KEY]: JSON.stringify(pool) });
	const status = await worker.fetch(new Request('https://unit.example/.well-known/address-pool/status'), { KV: kv }, { waitUntil() {} });
	assert.equal(status.status, 200);
	assert.equal((await status.json()).available, true);
	const wrongStatusMethod = await worker.fetch(new Request('https://unit.example/.well-known/address-pool/status', { method: 'POST' }), { KV: kv }, { waitUntil() {} });
	assert.equal(wrongStatusMethod.status, 405);
	const wrongRefreshMethod = await worker.fetch(new Request('https://unit.example/.well-known/address-pool/refresh'), { KV: kv }, { waitUntil() {} });
	assert.equal(wrongRefreshMethod.status, 405);
});

test('builds a standard Base64 subscription for Shadowrocket from only the managed pool', async () => {
	const uuid = '11111111-1111-4111-8111-111111111111';
	const hostname = 'unit.example';
	const firstHash = nodeCrypto.createHash('md5').update(hostname + uuid).digest('hex');
	const token = nodeCrypto.createHash('md5').update(firstHash.slice(7, 27)).digest('hex');
	const pool = {
		version: 1,
		source: 'public',
		updatedAt: new Date().toISOString(),
		upstreamUpdatedAt: '2026-07-26 00:39',
		rawCount: 2,
		invalidCount: 0,
		duplicateCount: 0,
		uniqueCount: 2,
		entries: [
			{ server: '1.1.1.1', port: 443, region: 'HK', regionNote: 'HK', name: '[池]HK-001' },
			{ server: '8.8.8.8', port: 443, region: 'US', regionNote: 'US', name: '[池]US-001' },
		],
	};
	const kv = memoryKv({ [PUBLIC_ADDRESS_CACHE_KEY]: JSON.stringify(pool) });
	const request = new Request(`https://${hostname}/sub?token=${token}&target=mixed`, {
		headers: { 'User-Agent': 'Shadowrocket/2.2' },
	});
	Object.defineProperty(request, 'cf', {
		value: {
			colo: 'HKG',
			country: 'HK',
			asn: 13335,
			asOrganization: 'Cloudflare',
		},
	});
	const background = [];
	const nativeWebCrypto = globalThis.crypto;
	const subtle = new Proxy(nativeWebCrypto.subtle, {
		get(target, property) {
			if (property === 'digest') {
				return async (algorithm, data) => {
					const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
					if (String(name).toUpperCase() === 'MD5') {
						const digest = nodeCrypto.createHash('md5').update(Buffer.from(data)).digest();
						return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
					}
					return target.digest.call(target, algorithm, data);
				};
			}
			return Reflect.get(target, property, target);
		},
	});
	const webCryptoWithMd5 = new Proxy(nativeWebCrypto, {
		get(target, property) {
			return property === 'subtle' ? subtle : Reflect.get(target, property, target);
		},
	});
	Object.defineProperty(globalThis, 'crypto', {
		value: webCryptoWithMd5,
		configurable: true,
	});
	let response;
	try {
		response = await worker.fetch(request, {
			ADMIN: 'unit-test-only',
			UUID: uuid,
			OFF_LOG: 'true',
			KV: kv,
		}, {
			waitUntil(promise) {
				background.push(promise);
			},
		});
		await Promise.all(background);
	} finally {
		Object.defineProperty(globalThis, 'crypto', {
			value: nativeWebCrypto,
			configurable: true,
		});
	}

	assert.equal(response.status, 200);
	const decoded = Buffer.from(await response.text(), 'base64').toString('utf8');
	const nodes = decoded.trim().split('\n');
	assert.equal(nodes.length, 2);
	assert.ok(nodes.every(node => node.startsWith(`vless://${uuid}@`)));
	assert.ok(nodes.some(node => node.includes('@1.1.1.1:443?')));
	assert.ok(nodes.some(node => node.includes('@8.8.8.8:443?')));
	assert.ok(nodes.every(node => node.includes(`sni=${hostname}`)));
	assert.ok(nodes.every(node => node.includes(`host=${hostname}`)));
	assert.ok(nodes.some(node => decodeURIComponent(node).includes('[池]HK-001')));
	assert.equal(kv.writes.filter(write => write.key === PUBLIC_ADDRESS_CACHE_KEY).length, 0);
});
