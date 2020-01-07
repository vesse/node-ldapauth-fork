var assert = require('assert');
var ldap = require('ldapjs');
var format = require('util').format;
var bcrypt = require('bcryptjs');
var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
/**
 * Copyright 2011 (c) Trent Mick.
 * Modified Work Copyright 2013 Vesa Poikajärvi.
 *
 * LDAP auth.
 *
 * Usage:
 *    var LdapAuth = require('ldapauth');
 *    var auth = new LdapAuth({url: 'ldaps://ldap.example.com:636', ...});
 *    ...
 *    auth.authenticate(username, password, function(err, user) { ... });
 *    ...
 *    auth.close(function(err) { ... })
 */


/**
 * Void callback
 *
 * @callback voidCallback
 * @param {(Error|undefined)} err - Possible error
 */
/**
 * Result callback
 *
 * @callback resultCallback
 * @param {(Error|undefined)} err - Possible error
 * @param {(Object|undefined)} res - Result
 */

/**
 * Get option that may be defined under different names, but accept
 * the first one that is actually defined in the given object
 *
 * @private
 * @param {object} obj - Config options
 * @param {string[]} keys - List of keys to look for
 * @return {*} The value of the first matching key
 */
var getOption = function(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] in obj) {
      return obj[keys[i]];
    }
  }
  return undefined;
};

/**
 * Create an LDAP auth class. Primary usage is the `.authenticate` method.
 *
 * @param {Object} opts - Config options
 * @constructor
 */
function LdapAuth(opts) {
  this.opts = opts;
  assert.ok(opts.url, 'LDAP server URL not defined (opts.url)');
  assert.ok(opts.searchFilter, 'Search filter not defined (opts.searchFilter)');

  this.log = opts.log && opts.log.child({ component: 'ldapauth' }, true);

  this.opts.searchScope || (this.opts.searchScope = 'sub');
  this.opts.bindProperty || (this.opts.bindProperty = 'dn');
  this.opts.groupSearchScope || (this.opts.groupSearchScope = 'sub');
  this.opts.groupDnProperty || (this.opts.groupDnProperty = 'dn');

  EventEmitter.call(this);

  if (opts.cache) {
    // eslint-disable-next-line global-require
    var Cache = require('./cache');
    this.userCache = new Cache(100, 300, this.log, 'user');
    this._salt = bcrypt.genSaltSync();
  }

  // TODO: This should be fixed somehow
  this.clientOpts = {
    url: opts.url,
    tlsOptions: opts.tlsOptions,
    socketPath: opts.socketPath,
    log: opts.log,
    timeout: opts.timeout,
    connectTimeout: opts.connectTimeout,
    idleTimeout: opts.idleTimeout,
    reconnect: opts.reconnect,
    strictDN: opts.strictDN,
    queueSize: opts.queueSize,
    queueTimeout: opts.queueTimeout,
    queueDisable: opts.queueDisable
  };

  // Not passed to ldapjs, don't want to autobind
  // https://github.com/mcavage/node-ldapjs/blob/v1.0.1/lib/client/client.js#L343-L356
  this.bindDN = getOption(opts, ['bindDn', 'bindDN', 'adminDn']);
  this.bindCredentials = getOption(opts, ['bindCredentials', 'Credentials', 'adminPassword']);

  this._adminClient = ldap.createClient(this.clientOpts);
  this._adminBound = false;
  this._userClient = ldap.createClient(this.clientOpts);

  this._adminClient.on('error', this._handleError.bind(this));
  this._userClient.on('error', this._handleError.bind(this));

  var self = this;
  if (this.opts.starttls) {
    // When starttls is enabled, this callback supplants the 'connect' callback
    this._adminClient.starttls(this.opts.tlsOptions, this._adminClient.controls, function(err) {
      if (err) {
        self._handleError(err);
      } else {
        self._onConnectAdmin();
      }
    });
    this._userClient.starttls(this.opts.tlsOptions, this._userClient.controls, function(err) {
      if (err) {
        self._handleError(err);
      }
    });
  } else if (opts.reconnect) {
    this.once('_installReconnectListener', function() {
      self.log && self.log.trace('install reconnect listener');
      self._adminClient.on('connect', function() {
        self._onConnectAdmin();
      });
    });
  }

  this._adminClient.on('connectTimeout', this._handleError.bind(this));
  this._userClient.on('connectTimeout', this._handleError.bind(this));

  if (opts.groupSearchBase && opts.groupSearchFilter) {
    if (typeof opts.groupSearchFilter === 'string') {
      var groupSearchFilter = opts.groupSearchFilter;
      opts.groupSearchFilter = function(user) {
        return groupSearchFilter
          .replace(/{{dn}}/g, user[opts.groupDnProperty])
          .replace(/{{username}}/g, user.uid);
      };
    }

    this._getGroups = this._findGroups;
  } else {
    // Assign an async identity function so there is no need to branch
    // the authenticate function to have cache set up.
    this._getGroups = function(user, callback) {
      return callback(null, user);
    };
  }
}

inherits(LdapAuth, EventEmitter);

/**
 * Unbind connections
 *
 * @param {voidCallback} callback - Callback
 * @returns {undefined}
 */
LdapAuth.prototype.close = function(callback) {
  var self = this;
  // It seems to be OK just to call unbind regardless of if the
  // client has been bound (e.g. how ldapjs pool destroy does)
  self._adminClient.unbind(function() {
    self._userClient.unbind(callback);
  });
};


/**
 * Mark admin client unbound so reconnect works as expected and re-emit the error
 *
 * @private
 * @param {Error} err - The error to be logged and emitted
 * @returns {undefined}
 */
LdapAuth.prototype._handleError = function(err) {
  this.log && this.log.trace('ldap emitted error: %s', err);
  this._adminBound = false;
  this.emit('error', err);
};

/**
 * Bind adminClient to the admin user on connect
 *
 * @private
 * @param {voidCallback} callback - Callback that checks possible error, optional
 * @returns {undefined}
 */
LdapAuth.prototype._onConnectAdmin = function(callback) {
  var self = this;

  // Anonymous binding
  if (typeof self.bindDN === 'undefined' || self.bindDN === null) {
    self._adminBound = true;
    return callback ? callback() : null;
  }

  self.log && self.log.trace('ldap authenticate: bind: %s', self.bindDN);
  self._adminClient.bind(
    self.bindDN,
    self.bindCredentials,
    function(err) {
      if (err) {
        self.log && self.log.trace('ldap authenticate: bind error: %s', err);
        self._adminBound = false;
        return callback ? callback(err) : null;
      }

      self.log && self.log.trace('ldap authenticate: bind ok');
      self._adminBound = true;
      if (self.opts.reconnect) {
        self.emit('_installReconnectListener');
      }
      return callback ? callback() : null;
    });
};

/**
 * Ensure that `this._adminClient` is bound.
 *
 * @private
 * @param {voidCallback} callback - Callback that checks possible error
 * @returns {undefined}
 */
LdapAuth.prototype._adminBind = function(callback) {
  if (this._adminBound) {
    return callback();
  }

  // Call the connect handler with a callback
  return this._onConnectAdmin(callback);
};

/**
 * Conduct a search using the admin client. Used for fetching both
 * user and group information.
 *
 * @private
 * @param {string} searchBase - LDAP search base
 * @param {Object} options - LDAP search options
 * @param {string} options.filter - LDAP search filter
 * @param {string} options.scope - LDAP search scope
 * @param {(string[]|undefined)} options.attributes - Attributes to fetch
 * @param {resultCallback} callback - The result handler callback
 * @returns {undefined}
 */
LdapAuth.prototype._search = function(searchBase, options, callback) {
  var self = this;

  self._adminBind(function(bindErr) {
    if (bindErr) {
      return callback(bindErr);
    }

    self._adminClient.search(searchBase, options, function(searchErr, searchResult) {
      if (searchErr) {
        return callback(searchErr);
      }

      var items = [];
      searchResult.on('searchEntry', function(entry) {
        items.push(entry.object);
        if (self.opts.includeRaw === true) {
          items[items.length - 1]._raw = entry.raw;
        }
      });

      searchResult.on('error', callback);

      searchResult.on('end', function(result) {
        if (result.status !== 0) {
          var err = 'non-zero status from LDAP search: ' + result.status;
          return callback(err);
        }
        return callback(null, items);
      });
    });
  });
};

/**
 * Sanitize LDAP special characters from input
 *
 * {@link https://tools.ietf.org/search/rfc4515#section-3}
 *
 * @private
 * @param {string} input - String to sanitize
 * @returns {string} Sanitized string
 */
var sanitizeInput = function(input) {
  return input
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\\/g, '\\5c')
    .replace(/\0/g, '\\00')
    .replace(/\//g, '\\2f');
};

/**
 * Find the user record for the given username.
 *
 * @private
 * @param {string} username - Username to search for
 * @param {resultCallback} callback - Result handling callback. If user is
 * not found but no error happened, result is undefined.
 * @returns {undefined}
 */
LdapAuth.prototype._findUser = function(username, callback) {
  var self = this;
  if (!username) {
    return callback(new Error('empty username'));
  }

  var searchFilter = self.opts.searchFilter.replace(/{{username}}/g, sanitizeInput(username));
  var opts = { filter: searchFilter, scope: self.opts.searchScope };
  if (self.opts.searchAttributes) {
    opts.attributes = self.opts.searchAttributes;
  }

  self._search(self.opts.searchBase, opts, function(err, result) {
    if (err) {
      self.log && self.log.trace('ldap authenticate: user search error: %s %s %s', err.code, err.name, err.message);
      return callback(err);
    }

    switch (result.length) {
    case 0:
      return callback();
    case 1:
      return callback(null, result[0]);
    default:
      return callback(format(
        'unexpected number of matches (%s) for "%s" username',
        result.length, username));
    }
  });
};

/**
 * Find groups for given user
 *
 * @private
 * @param {Object} user - The LDAP user object
 * @param {resultCallback} callback - Result handling callback
 * @returns {undefined}
 */
LdapAuth.prototype._findGroups = function(user, callback) {
  var self = this;
  if (!user) {
    return callback(new Error('no user'));
  }

  var searchFilter = self.opts.groupSearchFilter(user);

  var opts = { filter: searchFilter, scope: self.opts.groupSearchScope };
  if (self.opts.groupSearchAttributes) {
    opts.attributes = self.opts.groupSearchAttributes;
  }
  self._search(self.opts.groupSearchBase, opts, function(err, result) {
    if (err) {
      self.log && self.log.trace('ldap authenticate: group search error: %s %s %s', err.code, err.name, err.message);
      return callback(err);
    }

    user._groups = result;
    callback(null, user);
  });
};

/**
 * Authenticate given credentials against LDAP server
 *
 * @param {string} username - The username to authenticate
 * @param {string} password - The password to verify
 * @param {resultCallback} callback - Result handling callback
 * @returns {undefined}
 */
LdapAuth.prototype.authenticate = function(username, password, callback) {
  var self = this;

  if (typeof password === 'undefined' || password === null || password === '') {
    return callback(new Error('no password given'));
  }

  if (self.opts.cache) {
    // Check cache. 'cached' is `{password: <hashed-password>, user: <user>}`.
    var cached = self.userCache.get(username);
    if (cached && bcrypt.compareSync(password, cached.password)) {
      return callback(null, cached.user);
    }
  }

  // 1. Find the user DN in question.
  self._findUser(username, function(findErr, user) {
    if (findErr) {
      return callback(findErr);
    } else if (!user) {
      return callback(format('no such user: "%s"', username));
    }

    // 2. Attempt to bind as that user to check password.
    self._userClient.bind(user[self.opts.bindProperty], password, function(bindErr) {
      if (bindErr) {
        self.log && self.log.trace('ldap authenticate: bind error: %s', bindErr);
        return callback(bindErr);
      }
      // 3. If requested, fetch user groups
      self._getGroups(user, function(groupErr, userWithGroups) {
        if (groupErr) {
          self.log && self.log.trace('ldap authenticate: group search error %s', groupErr);
          return callback(groupErr);
        }
        if (self.opts.cache) {
          bcrypt.hash(password, self._salt, function(err, hash) {
            if (err) {
              self.log && self.log.trace('ldap authenticate: bcrypt error, not caching %s', err);
            } else {
              self.userCache.set(username, { password: hash, user: userWithGroups });
            }
            return callback(null, userWithGroups);
          });
        } else {
          return callback(null, userWithGroups);
        }
      });
    });
  });
};



module.exports = LdapAuth;
