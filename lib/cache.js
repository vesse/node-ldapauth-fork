/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * An expiring LRU cache.
 *
 * Usage:
 *     var Cache = require('amon-common').Cache;
 *                                // size, expiry, log,  name
 *     this.accountCache = new Cache( 100,    300, log, 'account');
 *     this.accountCache.set('hamish', {...});
 *     ...
 *     this.accountCache.get('hamish')    // -> {...}
 */

var assert = require('assert');
var LRU = require('lru-cache');


/**
 * A LRU and expiring cache.
 *
 * @param {number} size Max number of entries to cache.
 * @param {number} expiry Number of seconds after which to expire entries.
 * @param {object} log Optional. All logging is at the Trace level.
 * @param {string} name Optional name for this cache. Just used for logging.
 * @constructor
 */
function Cache(size, expiry, log, name) {
  assert.ok(size !== undefined);
  assert.ok(expiry !== undefined);
  this.size = size;
  this.expiry = expiry * 1000;
  this.log = log;
  this.name = (name ? name + ' ' : '');
  this.items = new LRU({ max: this.size });
}

/**
 * Clear cache
 *
 * @returns {undefined}
 */
Cache.prototype.reset = function reset() {
  if (this.log) {
    this.log.trace('%scache reset', this.name);
  }
  this.items.reset();
};

/**
 * Get object from cache by given key
 *
 * @param {string} key - The cache key
 * @returns {*} The cached value or null if not found
 */
Cache.prototype.get = function get(key) {
  assert.ok(key !== undefined);
  var cached = this.items.get(key);
  if (cached) {
    if (((new Date()).getTime() - cached.ctime) <= this.expiry) {
      if (this.log) {
        this.log.trace('%scache hit: key="%s": %o', this.name, key, cached);
      }
      return cached.value;
    }
  }
  if (this.log) {
    this.log.trace('%scache miss: key="%s"', this.name, key);
  }
  return null;
};

/**
 * Set a value to cache
 *
 * @param {string} key - Cache key
 * @param {*} value - The value to cache
 * @returns {*} The given value
 */
Cache.prototype.set = function set(key, value) {
  assert.ok(key !== undefined);
  var item = {
    value: value,
    ctime: new Date().getTime()
  };
  if (this.log) {
    this.log.trace('%scache set: key="%s": %o', this.name, key, item);
  }
  this.items.set(key, item);
  return item;
};

/**
 * Delete a single entry from cache
 *
 * @param {string} key - The cache key
 * @returns {undefined}
 */
Cache.prototype.del = function del(key) {
  if (this.log) {
    this.log.trace('%scache del: key="%s"', this.name, key);
  }
  this.items.del(key);
};


module.exports = Cache;
