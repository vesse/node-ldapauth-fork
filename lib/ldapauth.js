/**
 * Copyright 2011 (c) Trent Mick.
 *
 * LDAP auth.
 *
 * Usage:
 *    var LdapAuth = require('ldapauth');
 *    var auth = new LdapAuth({url: 'ldaps://ldap.example.com:663', ...});
 *    ...
 *    auth.authenticate(username, password, function (err, user) { ... });
 *    ...
 *    auth.close(function (err) { ... })
 */

var assert = require('assert');
var ldap = require('ldapjs');
var debug = console.warn;
var format = require('util').format;



/**
 * Create an LDAP auth class. Primary usage is the `.authenticate` method.
 *
 * @param opts {Object} Config options. Keys (required, unless says
 *      otherwise) are:
 *    url {String} E.g. 'ldaps://ldap.example.com:663'
 *    adminDn {String} Optional, e.g. 'uid=myapp,ou=users,o=example.com'
 *    adminPassword {String} Password for adminDn.
 *    searchBase {String} The base DN from which to search for users by
 *        username. E.g. 'ou=users,o=example.com'
 *    searchScope {String} Optional, default 'sub'. Scope of the search, one
 *        of 'base', 'one', or 'sub'.
 *    searchFilter {String} LDAP search filter with which to find a user by
 *        username, e.g. '(uid={{username}})'. Use the literal '{{username}}'
 *        to have the given username be interpolated in for the LDAP
 *        search.
 *    searchAttributes {Array} Optional, default all. Array of attributes to
 *        fetch from LDAP server.
 *    log4js {Module} Optional. The require'd log4js module to use for logging.
 *        logging. If given this will result in TRACE-level logging for
 *        ldapauth.
 *    verbose {Boolean} Optional, default false. If `log4js` is also given,
 *        this will add TRACE-level logging for ldapjs (quite verbose).
 *    cache {Boolean} Optional, default false. If true, then up to 100
 *        credentials at a time will be cached for 5 minutes.
 *    timeout {Integer} Optional, default Infinity. How long the client should
 *        let operations live for before timing out.
 *    connectTimeout {Integer} Optional, default is up to the OS. How long the
 *        client should wait before timing out on TCP connections.
 *    tlsOptions {Object} Additional options passed to the TLS connection layer
 *        when connecting via ldaps://. See
 *        http://nodejs.org/api/tls.html#tls_tls_connect_options_callback
 *        for available options
 *    maxConnections {Integeer}
 *        Whether or not to enable connection pooling, and if so, how many to maintain.
 *    bindDN {String}
 *        Defaults to adminDn
 *    bindCredentials {String}
 *        Defaults to adminPassword
 *    checkInterval {Integer}
 *        How often to schedule health checks for the connection pool.
 *    maxIdleTime {Integer}
 *        How long a client can be idle before health-checking the connection (subject to the checkInterval frequency)
 */
function LdapAuth(opts) {
  this.opts = opts;
  assert.ok(opts.url);
  assert.ok(opts.searchBase);
  assert.ok(opts.searchFilter);

  this.log = opts.log4js && opts.log4js.getLogger('ldapauth');

  this.opts.searchScope || (this.opts.searchScope = 'sub')

  if (opts.cache) {
    var Cache = require('./cache');
    this.userCache = new Cache(100, 300, this.log, 'user');
  }

  var clientOpts = {
    url: opts.url,
    connectTimeout: opts.connectTimeout,
    timeout: opts.timeout,
    tlsOptions: opts.tlsOptions,
    maxConnections: opts.maxConnections,
    bindDn: opts.bindDn || opts.adminDn,
    bindCredentials: opts.Credentials || opts.adminPassword,
    checkInterval: opts.checkInterval,
    maxIdleTime: opts.maxIdleTime
  };

  if (opts.log4js && opts.verbose) {
    clientOpts.log4js = opts.log4js;
  }

  this._adminClient = ldap.createClient(clientOpts);
  this._adminBound = false;
  this._userClient = ldap.createClient(clientOpts);

  if (opts.cache) {
    var bcrypt = require('bcrypt');
    this._salt = bcrypt.genSaltSync();
  }
}


LdapAuth.prototype.close = function (callback) {
  var self = this;
  // It seems to be OK just to call unbind regardless of if the
  // client has been bound (e.g. how ldapjs pool destroy does)
  self._adminClient.unbind(function(err) {
    self._userClient.unbind(callback);
  });
}


/**
 * Ensure that `this._adminClient` is bound.
 */
LdapAuth.prototype._adminBind = function (callback) {
  // Anonymous binding
  if (typeof this.opts.adminDn === 'undefined' || this.opts.adminDn === null) {
    return callback();
  }
  if (this._adminBound) {
    return callback();
  }
  var self = this;
  this._adminClient.bind(this.opts.adminDn, this.opts.adminPassword,
                         function (err) {
    if (err) {
      self.log && self.log.trace('ldap authenticate: bind error: %s', err);
      return callback(err);
    }
    self._adminBound = true;
    return callback();
  });
}


/**
 * Find the user record for the given username.
 *
 * @param username {String}
 * @param callback {Function} `function (err, user)`. If no such user is
 *    found but no error processing, then `user` is undefined.
 *
 */
LdapAuth.prototype._findUser = function (username, callback) {
  var self = this;
  if (!username) {
    return callback("empty username");
  }
  self._adminBind(function (err) {
    if (err)
      return callback(err);

    var searchFilter = self.opts.searchFilter.replace(/{{username}}/g, username);
    var opts = {filter: searchFilter, scope: self.opts.searchScope};
    if (self.opts.searchAttributes) {
      opts.attributes = self.opts.searchAttributes;
    }
    self._adminClient.search(self.opts.searchBase, opts,
                             function (err, result) {
      if (err) {
        self.log && self.log.trace('ldap authenticate: search error: %s', err);
        return callback(err);
      }
      var items = [];
      result.on('searchEntry', function (entry) {
        items.push(entry.object);
      });
      result.on('error', function (err) {
        self.log && self.log.trace(
          'ldap authenticate: search error event: %s', err);
        return callback(err);
      });
      result.on('end', function (result) {
        if (result.status !== 0) {
          var err = 'non-zero status from LDAP search: ' + result.status;
          self.log && self.log.trace('ldap authenticate: %s', err);
          return callback(err);
        }
        switch (items.length) {
        case 0:
          return callback();
        case 1:
          return callback(null, items[0])
        default:
          return callback(format(
            'unexpected number of matches (%s) for "%s" username',
            items.length, username));
        }
      });
    });
  });
}


/**
 *
 */
LdapAuth.prototype.authenticate = function (username, password, callback) {
  var self = this;

  if (self.opts.cache) {
    // Check cache. 'cached' is `{password: <hashed-password>, user: <user>}`.
    var cached = self.userCache.get(username);
    var bcrypt = require('bcrypt');
    if (cached && bcrypt.compareSync(password, cached.password)) {
      return callback(null, cached.user)
    }
  }

  // 1. Find the user DN in question.
  self._findUser(username, function (err, user) {
    if (err)
      return callback(err);
    if (!user)
      return callback(format('no such user: "%s"', username));
    // 2. Attempt to bind as that user to check password.
    self._userClient.bind(user.dn, password, function (err) {
      if (err) {
        self.log && self.log.trace('ldap authenticate: bind error: %s', err);
        return callback(err);
      }
      if (self.opts.cache) {
        var bcrypt = require('bcrypt');
        bcrypt.hash(password, self._salt, function (err, hash) {
          self.userCache.set(username, {password: hash, user: user});
          return callback(null, user);
        });
      } else {
        return callback(null, user);
      }
    });
  });
}



module.exports = LdapAuth;
