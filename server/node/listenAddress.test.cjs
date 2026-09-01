'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatListenHost, resolveListenHost } = require('./listenAddress.cjs');

test('resolveListenHost preserves legacy behavior when RISU_HOST is unset', () => {
    assert.equal(resolveListenHost({}), null);
    assert.equal(resolveListenHost({ RISU_HOST: '   ' }), null);
});

test('resolveListenHost accepts explicit localhost and LAN bindings', () => {
    assert.equal(resolveListenHost({ RISU_HOST: '127.0.0.1' }), '127.0.0.1');
    assert.equal(resolveListenHost({ RISU_HOST: '0.0.0.0' }), '0.0.0.0');
});

test('formatListenHost produces usable display hosts', () => {
    assert.equal(formatListenHost(null), 'localhost');
    assert.equal(formatListenHost('0.0.0.0'), 'localhost');
    assert.equal(formatListenHost('127.0.0.1'), '127.0.0.1');
    assert.equal(formatListenHost('::1'), '[::1]');
});
