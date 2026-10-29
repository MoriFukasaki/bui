import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { iceConfiguration } from '../ice.mjs';

test('STUN-only configuration reports that cross-network relay is missing', () => {
  const result = iceConfiguration({});
  assert.equal(result.turnConfigured, false); assert.equal(result.iceTransportPolicy, 'all');
  assert.ok(result.iceServers[0].urls.startsWith('stun:'));
});
test('provider username/password support UDP, TCP and TLS TURN endpoints', () => {
  const result = iceConfiguration({ TURN_URLS: 'turn:relay.example.com:80, turns:relay.example.com:443?transport=tcp', TURN_USERNAME: 'synthetic-user', TURN_PASSWORD: 'synthetic-password', ICE_TRANSPORT_POLICY: 'relay' });
  assert.equal(result.turnConfigured, true); assert.equal(result.iceTransportPolicy, 'relay');
  assert.equal(result.iceServers[1].urls.length, 2); assert.equal(result.iceServers[1].credential, 'synthetic-password');
});
test('coturn shared secret is converted to an expiring credential, never sent as the secret', () => {
  const result = iceConfiguration({ TURN_URLS: 'turn:relay.example.com:3478', TURN_SECRET: 'synthetic-shared-secret' }, 1000000);
  const server = result.iceServers[1];
  assert.equal(server.username, '87400:camroom');
  assert.equal(server.credential, createHmac('sha1', 'synthetic-shared-secret').update(server.username).digest('base64'));
  assert.ok(!JSON.stringify(result).includes('synthetic-shared-secret'));
});
test('invalid or incomplete relay configuration fails with an actionable error', () => {
  for (const env of [
    { TURN_URLS: 'turn:relay.example.com:80' }, { TURN_PASSWORD: 'synthetic-password' },
    { TURN_URLS: 'https://example.com', TURN_SECRET: 'synthetic-secret' },
    { TURN_URLS: 'turn:relay.example.com', TURN_SECRET: 'a', TURN_USERNAME: 'b', TURN_PASSWORD: 'c' },
    { ICE_TRANSPORT_POLICY: 'relay' }, { ICE_TRANSPORT_POLICY: 'invalid' },
  ]) assert.throws(() => iceConfiguration(env));
});
